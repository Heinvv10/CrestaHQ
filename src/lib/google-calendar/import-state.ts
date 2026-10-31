import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { IMPORTED_EVENT_SOURCE } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";
import {
  gcalConnectionPath,
  isActiveMember,
  isConnectionUid,
  type GoogleCalendarConnection,
  type ImportMode,
} from "./connection";
import { BUSY_TITLE } from "./import-map";

/**
 * Who may have imported events, and the cleanups that remove them. Three
 * keys, all required: the agency gate (`googleCalendarEnabledByAgency`), the
 * workspace allowance (`calendarImportAllowed`, a sub-account admin) and the
 * member's own opt-in (`importMode` on their connection) — plus the member
 * still being active. Any key off means nothing of that member's calendar
 * may stay visible.
 *
 * Race rule: every switch-off writes its key (and bumps a generation) FIRST
 * and deletes AFTER. The import commits each batch in a transaction that
 * re-reads the sub-account and connection docs and refuses if their
 * fingerprint moved, so a batch either lands before the switch (and the
 * delete that follows removes it) or sees the switch and writes nothing.
 */

type SubData = Pick<SubAccountDoc, "googleCalendarEnabledByAgency" | "calendarImportAllowed" | "calendarImportGeneration">;

const BATCH = 400;
const CONN_PREFIX = "googleCalendar_";

export function importModeOn(mode: ImportMode | null | undefined): mode is "busy" | "details" {
  return mode === "busy" || mode === "details";
}

/** The agency gate AND the admin's allowance. */
export function workspaceAllowsImport(sub: SubData | null | undefined): boolean {
  return sub?.googleCalendarEnabledByAgency === true && sub?.calendarImportAllowed === true;
}

export const ms = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  return (v as { toMillis?: () => number } | null)?.toMillis?.() ?? 0;
};

/**
 * Every key an import pass started under; a changed value means a cleanup is
 * (or was) running. `connectedAt` and `status` too: a reconnect (perhaps to
 * another Google account) or a revoked grant is a different connection even
 * when its opt-in and generation happen to read the same again.
 */
export function importFingerprint(sub: SubData | null | undefined, conn: GoogleCalendarConnection | null): string {
  return [
    sub ? "sa" : "no-sa",
    workspaceAllowsImport(sub) ? "on" : "off",
    sub?.calendarImportGeneration ?? 0,
    conn ? (conn.importMode ?? "off") : "no-conn",
    conn?.importGeneration ?? 0,
    conn?.status ?? "-",
    ms(conn?.connectedAt),
  ].join("|");
}

export interface ImportState {
  sub: SubData | null;
  agencyId: string | null;
  conn: GoogleCalendarConnection | null;
  print: string;
  eligible: boolean;
}

export async function readImportState(subAccountId: string, uid: string): Promise<ImportState> {
  const db = getAdminDb();
  const [subSnap, connSnap, active] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.doc(gcalConnectionPath(subAccountId, uid)).get(),
    isActiveMember(subAccountId, uid),
  ]);
  const sub = subSnap.exists ? (subSnap.data() as SubData & { agencyId?: string }) : null;
  const conn = connSnap.exists ? (connSnap.data() as GoogleCalendarConnection) : null;
  return {
    sub,
    agencyId: (sub as { agencyId?: string } | null)?.agencyId ?? null,
    conn,
    print: importFingerprint(sub, conn),
    // A revoked grant is not eligible either: its copy would never update again.
    eligible: workspaceAllowsImport(sub) && importModeOn(conn?.importMode) && conn?.status === "connected" && active,
  };
}

function importedQuery(subAccountId: string, uid?: string) {
  // "" is not "everyone": a blank uid must never widen to the whole workspace.
  if (uid === "") throw new Error("google-calendar/import: empty uid");
  let q = getAdminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("source", "==", IMPORTED_EVENT_SOURCE);
  if (uid !== undefined) q = q.where("importOwnerUid", "==", uid);
  return q;
}

/** All of one member's imported docs (equality-only: no composite index). */
export async function loadImported(subAccountId: string, uid: string) {
  return (await importedQuery(subAccountId, uid).get()).docs;
}

/**
 * Deletes imported events — one member's, or (no uid) the whole
 * workspace's. Pages until none are left. Returns how many went.
 */
export async function deleteImportedEvents(subAccountId: string, uid?: string): Promise<number> {
  const db = getAdminDb();
  let removed = 0;
  for (;;) {
    const page = await importedQuery(subAccountId, uid).limit(BATCH).get();
    if (page.empty) return removed;
    const batch = db.batch();
    for (const d of page.docs) batch.delete(d.ref);
    await batch.commit();
    removed += page.size;
  }
}

/**
 * One member's imports, deleted only while the keys still read `print`: each
 * page is deleted in a transaction that re-reads the sub-account and
 * connection, so a pass that judged the member ineligible cannot wipe what a
 * fresh opt-in has written since. Null when the keys moved (nothing more is
 * deleted; the newer change owns the state).
 */
export async function deleteImportedEventsIfUnchanged(
  subAccountId: string,
  uid: string,
  print: string,
): Promise<number | null> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const connRef = db.doc(gcalConnectionPath(subAccountId, uid));
  let removed = 0;
  for (;;) {
    const page = await importedQuery(subAccountId, uid).limit(BATCH).get();
    const ok = await db.runTransaction(async (tx) => {
      const [s, c] = await tx.getAll(subRef, connRef);
      if (importFingerprint(s.exists ? s.data() : null, c.exists ? (c.data() as GoogleCalendarConnection) : null) !== print) {
        return false;
      }
      for (const d of page.docs) tx.delete(d.ref);
      return true;
    });
    if (!ok) return null;
    if (page.empty) return removed;
    removed += page.size;
  }
}

/** Times only, right now: titles and places go before the next sync. */
export async function stripImportedDetails(subAccountId: string, uid: string): Promise<void> {
  const db = getAdminDb();
  const docs = (await loadImported(subAccountId, uid)).filter((d) => d.data().importMode !== "busy");
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + BATCH)) {
      batch.update(d.ref, { title: BUSY_TITLE, location: "", importMode: "busy", updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }
}

/**
 * Make the stored imports match the CURRENT keys: delete when any is off,
 * strip when busy-only. The delete is guarded like a pass's own: if the keys
 * move again meanwhile, the newer change owns the state.
 */
export async function enforceCurrentImportState(subAccountId: string, uid: string): Promise<void> {
  const state = await readImportState(subAccountId, uid);
  if (!state.eligible) {
    if ((await deleteImportedEventsIfUnchanged(subAccountId, uid, state.print)) !== null) {
      await retireRevokedOptIn(subAccountId, uid, state);
    }
  } else if (state.conn?.importMode === "busy") await stripImportedDetails(subAccountId, uid);
}

/**
 * A revoked (or otherwise not connected) grant's opt-in goes to off, after
 * its imports were deleted: it stops being a sweep target, and a reconnect
 * starts from off anyway. Only while the keys still read `state.print`.
 */
export async function retireRevokedOptIn(subAccountId: string, uid: string, state: ImportState): Promise<void> {
  const { conn, print } = state;
  if (!conn || conn.status === "connected" || !importModeOn(conn.importMode)) return;
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const connRef = db.doc(gcalConnectionPath(subAccountId, uid));
  try {
    await db.runTransaction(async (tx) => {
      const [s, c] = await tx.getAll(subRef, connRef);
      if (!c.exists) return;
      if (importFingerprint(s.exists ? s.data() : null, c.data() as GoogleCalendarConnection) !== print) return;
      tx.update(connRef, {
        importMode: "off",
        importGeneration: FieldValue.increment(1),
        importSyncToken: null,
        importedCount: 0,
      });
    });
  } catch (err) {
    // The imports are already gone; the next sweep tick retries.
    console.warn(
      `[google-calendar/import] could not retire a revoked opt-in sa=${subAccountId} uid=${uid}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** setImportMode refused a mode that switches import ON. */
export class ImportModeRefusedError extends Error {
  constructor(readonly code: "not_allowed" | "not_connected") {
    super(`google-calendar/import: ${code}`);
    this.name = "ImportModeRefusedError";
  }
}

/**
 * The member's own opt-in. The generation bump comes first (see the race
 * rule); a new mode also forgets the sync token, so the next pass is a full
 * walk under the new detail level, and the last pass's status, error and sync
 * time are cleared so nothing stale is shown for it. Switching ON re-checks the workspace keys
 * and the connection INSIDE the transaction (throws ImportModeRefusedError),
 * so an admin's switch-off between the route's check and this write cannot
 * leave an opt-in behind. Off always goes through. Returns how many imports
 * were removed.
 */
export async function setImportMode(subAccountId: string, uid: string, mode: ImportMode): Promise<number> {
  const db = getAdminDb();
  const ref = db.doc(gcalConnectionPath(subAccountId, uid));
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const prev = await db.runTransaction(async (tx) => {
    const [subSnap, snap] = await tx.getAll(subRef, ref);
    if (mode !== "off") {
      if (!workspaceAllowsImport(subSnap.data() as SubData | undefined)) throw new ImportModeRefusedError("not_allowed");
      if ((snap.data() as GoogleCalendarConnection | undefined)?.status !== "connected") {
        throw new ImportModeRefusedError("not_connected");
      }
    }
    if (!snap.exists) return null;
    tx.update(ref, {
      importMode: mode,
      importGeneration: FieldValue.increment(1),
      importSyncToken: null,
      importLastFullSyncAt: null,
      // A new mode starts a new first pass, so the last pass's outcome no longer describes it.
      importStatus: null,
      importError: null,
      importLastSyncAt: null,
      ...(mode === "off" ? { importedCount: 0 } : {}),
    });
    return (snap.data() as GoogleCalendarConnection).importMode ?? "off";
  });
  if (mode === "off") return deleteImportedEvents(subAccountId, uid);
  if (mode === "busy" && prev === "details") await stripImportedDetails(subAccountId, uid);
  return 0;
}

/** Members' connection docs that have import on (fakes and other private docs excluded). */
async function optedInConnections(subAccountId: string) {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/private`)
    .where("importMode", "in", ["busy", "details"])
    .get();
  return snap.docs.filter((d) => {
    const uid = d.id.startsWith(CONN_PREFIX) ? d.id.slice(CONN_PREFIX.length) : "";
    return uid !== "" && (d.data() as GoogleCalendarConnection).uid === uid;
  });
}

/**
 * The admin's workspace switch. Off resets every member to off too, so
 * allowing it again never re-exposes anyone's calendar without them choosing
 * again, then removes every import. Returns how many were removed.
 */
export async function setWorkspaceImportAllowed(subAccountId: string, allowed: boolean): Promise<number> {
  const db = getAdminDb();
  await db.doc(`subAccounts/${subAccountId}`).update({
    calendarImportAllowed: allowed,
    calendarImportGeneration: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (allowed) return 0;
  const conns = await optedInConnections(subAccountId);
  for (let i = 0; i < conns.length; i += BATCH) {
    const batch = db.batch();
    for (const d of conns.slice(i, i + BATCH)) {
      batch.update(d.ref, { importMode: "off", importGeneration: FieldValue.increment(1), importSyncToken: null, importedCount: 0 });
    }
    await batch.commit();
  }
  return deleteImportedEvents(subAccountId);
}

/** One read: does any workspace allow import? (The tick publishes nothing otherwise.) */
export async function anyWorkspaceAllowsImport(): Promise<boolean> {
  const snap = await getAdminDb().collection("subAccounts").where("calendarImportAllowed", "==", true).limit(1).get();
  return !snap.empty;
}

/**
 * Members to sync this tick, least recently attempted first. Workspaces
 * whose agency gate is off are still listed: their pass deletes.
 */
export async function listImportTargets(): Promise<Array<{ subAccountId: string; uid: string }>> {
  const subs = await getAdminDb().collection("subAccounts").where("calendarImportAllowed", "==", true).get();
  const targets: Array<{ subAccountId: string; uid: string; last: number }> = [];
  for (const s of subs.docs) {
    for (const c of await optedInConnections(s.id)) {
      const data = c.data() as GoogleCalendarConnection;
      targets.push({
        subAccountId: s.id,
        uid: data.uid,
        last: Math.max(ms(data.importLastSyncAt), ms(data.importLastAttemptAt)),
      });
    }
  }
  return targets.sort((a, b) => a.last - b.last).map(({ subAccountId, uid }) => ({ subAccountId, uid }));
}

/**
 * Where the daily orphan sweep stopped. Under `system/`, whose rule lets
 * clients read only `gitpageStatus` (every `appConfig/*` doc is readable by
 * any active user, so not there).
 */
export const SWEEP_CURSOR_PATH = "system/calendarImportSweep";

/**
 * Safety net (daily): deletes imported docs whose workspace, member or
 * opt-in no longer allows them — whatever a failed cleanup left behind.
 * Resumes after the doc id the last run stopped at, so a collection larger
 * than one run's budget is still covered over the following days; reaching
 * the end resets the cursor, so the next run starts from the top. An
 * ineligible owner's imports go through the same guarded delete as a pass's
 * (with the print the verdict was taken under), so a member who opts in
 * while the sweep runs keeps what their fresh import wrote.
 */
export async function sweepOrphanedImports(deadlineMs: number): Promise<number> {
  const db = getAdminDb();
  // print null: the uid cannot even name a connection doc, so nothing can
  // ever import for it — its docs are deleted outright. skip: reading the
  // owner's state failed (a transient error is not a verdict) — their docs
  // stay until a later run.
  type Verdict = { eligible: boolean; print: string | null; skip?: boolean };
  const verdict = new Map<string, Promise<Verdict>>();
  const judge = (sa: string, uid: string) => {
    const key = `${sa}\n${uid}`;
    if (!verdict.has(key)) {
      verdict.set(
        key,
        !isConnectionUid(uid)
          ? Promise.resolve({ eligible: false, print: null })
          : readImportState(sa, uid).then(
              (s): Verdict => ({ eligible: s.eligible, print: s.print }),
              (err): Verdict => {
                console.warn(
                  `[google-calendar/import] orphan sweep skipped an owner sa=${sa} uid=${uid}`,
                  err instanceof Error ? err.message : String(err),
                );
                return { eligible: false, print: null, skip: true };
              },
            ),
      );
    }
    return verdict.get(key)!;
  };
  const owners = new Set<string>();
  let removed = 0;
  const cursorRef = db.doc(SWEEP_CURSOR_PATH);
  // An id cursor, not a snapshot: the cursor doc may be one just deleted.
  const saved = (await cursorRef.get()).data()?.cursor;
  let cursor: string | null = typeof saved === "string" && saved ? saved : null;
  let reachedEnd = false;
  while (Date.now() < deadlineMs) {
    let q = db
      .collection("events")
      .where("source", "==", IMPORTED_EVENT_SOURCE)
      .orderBy("__name__")
      .select("subAccountId", "importOwnerUid")
      .limit(BATCH);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) {
      reachedEnd = true;
      break;
    }
    const doomed: FirebaseFirestore.DocumentReference[] = [];
    for (const d of page.docs) {
      const sa = d.data().subAccountId;
      const uid = d.data().importOwnerUid;
      if (typeof sa !== "string" || !sa || typeof uid !== "string" || !uid) {
        doomed.push(d.ref);
        continue;
      }
      const v = await judge(sa, uid);
      if (v.eligible || v.skip) continue;
      if (v.print === null) {
        doomed.push(d.ref);
        continue;
      }
      // Once per owner per run: the guarded delete takes all of theirs, or
      // (keys moved) none, and then the newer change owns them.
      const key = `${sa}\n${uid}`;
      if (owners.has(key)) continue;
      owners.add(key);
      removed += (await deleteImportedEventsIfUnchanged(sa, uid, v.print)) ?? 0;
    }
    if (doomed.length > 0) {
      const batch = db.batch();
      for (const ref of doomed) batch.delete(ref);
      await batch.commit();
    }
    removed += doomed.length;
    cursor = page.docs[page.docs.length - 1].id;
    if (page.size < BATCH) {
      reachedEnd = true;
      break;
    }
  }
  await cursorRef.set({ cursor: reachedEnd ? null : cursor, updatedAt: FieldValue.serverTimestamp() });
  return removed;
}

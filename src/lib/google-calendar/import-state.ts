import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { IMPORTED_EVENT_SOURCE } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";
import {
  gcalConnectionPath,
  isActiveMember,
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

/** Every key an import pass started under; a changed value means a cleanup is (or was) running. */
export function importFingerprint(sub: SubData | null | undefined, conn: GoogleCalendarConnection | null): string {
  return [
    sub ? "sa" : "no-sa",
    workspaceAllowsImport(sub) ? "on" : "off",
    sub?.calendarImportGeneration ?? 0,
    conn ? (conn.importMode ?? "off") : "no-conn",
    conn?.importGeneration ?? 0,
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
    eligible: workspaceAllowsImport(sub) && importModeOn(conn?.importMode) && active,
  };
}

function importedQuery(subAccountId: string, uid?: string) {
  let q = getAdminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("source", "==", IMPORTED_EVENT_SOURCE);
  if (uid) q = q.where("importOwnerUid", "==", uid);
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

/** Make the stored imports match the CURRENT keys: delete when any is off, strip when busy-only. */
export async function enforceCurrentImportState(subAccountId: string, uid: string): Promise<void> {
  const state = await readImportState(subAccountId, uid);
  if (!state.eligible) await deleteImportedEvents(subAccountId, uid);
  else if (state.conn?.importMode === "busy") await stripImportedDetails(subAccountId, uid);
}

/**
 * The member's own opt-in. The generation bump comes first (see the race
 * rule); a new mode also forgets the sync token, so the next pass is a full
 * walk under the new detail level. Returns how many imports were removed.
 */
export async function setImportMode(subAccountId: string, uid: string, mode: ImportMode): Promise<number> {
  const db = getAdminDb();
  const ref = db.doc(gcalConnectionPath(subAccountId, uid));
  const prev = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.update(ref, {
      importMode: mode,
      importGeneration: FieldValue.increment(1),
      importSyncToken: null,
      importLastFullSyncAt: null,
      ...(mode === "off" ? { importedCount: 0, importStatus: null, importError: null } : {}),
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

const ms = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  return (v as { toMillis?: () => number } | null)?.toMillis?.() ?? 0;
};

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
 * Safety net (daily): deletes imported docs whose workspace, member or
 * opt-in no longer allows them — whatever a failed cleanup left behind.
 */
export async function sweepOrphanedImports(deadlineMs: number): Promise<number> {
  const db = getAdminDb();
  const verdict = new Map<string, Promise<boolean>>();
  const eligible = (sa: string, uid: string): Promise<boolean> => {
    const key = `${sa}\n${uid}`;
    if (!verdict.has(key)) {
      // A uid that cannot name a connection doc is not eligible.
      verdict.set(key, readImportState(sa, uid).then((s) => s.eligible, () => false));
    }
    return verdict.get(key)!;
  };
  let removed = 0;
  // An id cursor, not a snapshot: the cursor doc may be one just deleted.
  let cursor: string | null = null;
  while (Date.now() < deadlineMs) {
    let q = db
      .collection("events")
      .where("source", "==", IMPORTED_EVENT_SOURCE)
      .orderBy("__name__")
      .select("subAccountId", "importOwnerUid")
      .limit(BATCH);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    const doomed: FirebaseFirestore.DocumentReference[] = [];
    for (const d of page.docs) {
      const sa = d.data().subAccountId;
      const uid = d.data().importOwnerUid;
      if (typeof sa !== "string" || !sa || typeof uid !== "string" || !uid || !(await eligible(sa, uid))) {
        doomed.push(d.ref);
      }
    }
    if (doomed.length > 0) {
      const batch = db.batch();
      for (const ref of doomed) batch.delete(ref);
      await batch.commit();
    }
    removed += doomed.length;
    cursor = page.docs[page.docs.length - 1].id;
    if (page.size < BATCH) break;
  }
  return removed;
}

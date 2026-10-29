import "server-only";

import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  describeFailure,
  gcalConnectionPath,
  withBudget,
  withGoogleToken,
  type GoogleCalendarConnection,
} from "./connection";
import { importedEventDoc, importedEventDocId, mapGoogleEvent, sameImport, type ImportedFields } from "./import-map";
import {
  deleteImportedEventsIfUnchanged,
  enforceCurrentImportState,
  importFingerprint,
  loadImported,
  ms,
  readImportState,
  retireRevokedOptIn,
} from "./import-state";
import { getGcalProviderFor } from "./provider/select";
import { GcalSyncTokenExpiredError, type GcalSyncResult } from "./provider/types";

/**
 * Google Calendar import: one member's own Google events as read-only
 * `events` docs (`source: "google"`, owner in `importOwnerUid`), so the CRM
 * calendar shows when they are busy and booking pages keep their slots
 * blocked while live Google busy fails open. Keys and cleanups:
 * import-state.ts. Mapping and privacy: import-map.ts.
 *
 * events.list on the PRIMARY calendar under the existing `calendar.events`
 * scope. A full walk covers [now − 30 d, now + 180 d) and reconciles: what
 * Google no longer returns is deleted. Later passes are incremental from
 * Google's sync token; a refused token (410) falls back to a full walk, and
 * a full walk also runs daily so the window slides.
 */

const WINDOW_BACK_MS = 30 * 86_400_000;
const WINDOW_AHEAD_MS = 180 * 86_400_000;
const FULL_SYNC_EVERY_MS = 24 * 3_600_000;
const MAX_PAGES = 20;
const MAX_EVENTS_PER_MEMBER = 2_000;
const BATCH = 400;
/** The Google walk stops this long before the deadline, so the writes still fit. */
const WRITE_MARGIN_MS = 8_000;
const MIN_LIST_BUDGET_MS = 2_000;
/** One pass per member at a time; a pass that dies holds it this long at most. */
const LEASE_MS = 5 * 60_000;
const PARTIAL_SYNC = "Your Google Calendar has more events than one sync reads; some were skipped.";
const TOO_MANY = `Only the nearest ${MAX_EVENTS_PER_MEMBER} Google events are shown.`;

export interface ImportResult {
  ok: boolean;
  /**
   * not_eligible: a key is off (its imports were deleted). in_progress:
   * another pass holds the member's lease. cooldown: a full pass was asked
   * for within `minFullIntervalMs` of the last one.
   */
  skipped?: "not_eligible" | "settings_changed" | "in_progress" | "cooldown";
  full?: boolean;
  written?: number;
  deleted?: number;
  /** Fixed text per failure kind — safe to store and show. */
  error?: string;
}

type Op = (tx: FirebaseFirestore.Transaction) => void;

/**
 * One pass for one member. A failed Google walk or write lands on the
 * connection's `importError` and returns `ok: false`; only the opening
 * Firestore reads can throw. `minFullIntervalMs`: the settings route's
 * cooldown — a full pass started within it of the last full attempt is
 * skipped, so a member cannot hammer Google with Sync now / mode flips.
 */
export async function runCalendarImport(
  subAccountId: string,
  uid: string,
  opts: { full?: boolean; deadlineMs?: number; minFullIntervalMs?: number } = {},
): Promise<ImportResult> {
  const db = getAdminDb();
  const deadlineMs = opts.deadlineMs ?? Date.now() + 45_000;
  const state = await readImportState(subAccountId, uid);
  if (!state.eligible) {
    // Guarded: a fresh opt-in since `state` was read owns the imports now.
    const deleted = await deleteImportedEventsIfUnchanged(subAccountId, uid, state.print);
    if (deleted === null) return { ok: true, skipped: "settings_changed" };
    // A revoked grant's opt-in goes too, after its imports: it stops being a
    // sweep target, and a reconnect starts from off anyway.
    await retireRevokedOptIn(subAccountId, uid, state);
    return { ok: true, skipped: "not_eligible", deleted };
  }
  const conn = state.conn as GoogleCalendarConnection;
  const detail = conn.importMode === "details" ? "details" : "busy";
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const connRef = db.doc(gcalConnectionPath(subAccountId, uid));

  const now = Date.now();
  const window = { timeMin: new Date(now - WINDOW_BACK_MS), timeMax: new Date(now + WINDOW_AHEAD_MS) };
  const lastFull = ms(conn.importLastFullSyncAt);
  let full = opts.full === true || !conn.importSyncToken || !lastFull || now - lastFull > FULL_SYNC_EVERY_MS;

  /** Commit `ops` only while the keys still match what this pass started under. */
  const commit = (ops: Op[]) =>
    db.runTransaction(async (tx) => {
      const [s, c] = await tx.getAll(subRef, connRef);
      const print = importFingerprint(s.exists ? s.data() : null, c.exists ? (c.data() as GoogleCalendarConnection) : null);
      if (print !== state.print) return false;
      for (const op of ops) op(tx);
      return true;
    });

  // The member's lease: one pass at a time (the cron sweep, Sync now and a
  // mode change can all start one), claimed with the cooldown check.
  const leaseId = crypto.randomUUID();
  const claim = await db.runTransaction(async (tx) => {
    const [s, c] = await tx.getAll(subRef, connRef);
    const cur = c.exists ? (c.data() as GoogleCalendarConnection) : null;
    if (importFingerprint(s.exists ? s.data() : null, cur) !== state.print) return "settings_changed" as const;
    // A live lease blocks only a pass under the same keys: one taken under
    // older keys belongs to a pass whose every commit will be refused.
    if (ms(cur?.importLeaseUntil) > now && cur?.importLeasePrint === state.print) return "in_progress" as const;
    if (full && opts.minFullIntervalMs && now - ms(cur?.importLastFullAttemptAt) < opts.minFullIntervalMs) {
      return "cooldown" as const;
    }
    tx.update(connRef, {
      importLeaseId: leaseId,
      importLeaseUntil: new Date(now + LEASE_MS),
      importLeasePrint: state.print,
      importLastAttemptAt: new Date(now),
      ...(full ? { importLastFullAttemptAt: new Date(now) } : {}),
    });
    return "claimed" as const;
  });
  if (claim !== "claimed") return { ok: true, skipped: claim, full };
  try {
    return await leasedPass();
  } finally {
    await releaseLease(connRef, leaseId);
  }

  // Hoisted: the pass itself, run only under the lease.

  async function leasedPass(): Promise<ImportResult> {
    try {
      const provider = await getGcalProviderFor(subAccountId, uid);
      const walk = (syncToken: string | null, ordered = false): Promise<GcalSyncResult> =>
        withBudget(Math.max(MIN_LIST_BUDGET_MS, deadlineMs - Date.now() - WRITE_MARGIN_MS), (signal) =>
          withGoogleToken(
            conn,
            provider,
            (t) =>
              provider.syncEvents(
                t,
                {
                  syncToken,
                  ...window,
                  // Ordered = the upcoming events from now, soonest first.
                  ...(ordered ? { timeMin: new Date(now), ordered: true } : {}),
                  maxPages: MAX_PAGES,
                  details: detail === "details",
                },
                signal,
              ),
            signal,
          ),
        );
      let result: GcalSyncResult;
      try {
        result = await walk(full ? null : (conn.importSyncToken ?? null));
      } catch (err) {
        if (full || !(err instanceof GcalSyncTokenExpiredError)) throw err;
        full = true;
        result = await walk(null);
      }
      // A full walk that did not fit read an arbitrary part of the calendar.
      // Walk again ordered by start time from now, so what is kept is the
      // nearest upcoming events. Not the first walk: Google issues no sync
      // token for an ordered walk. Still "truncated" — absence proves nothing.
      if (full && result.truncated) {
        try {
          result = { ...(await walk(null, true)), nextSyncToken: null, truncated: true };
        } catch (err) {
          // Keep what the first walk read; it is still truncated.
          console.warn(
            `[google-calendar/import] ordered re-walk failed sa=${subAccountId} uid=${uid}`,
            err instanceof Error ? `${err.name}: ${err.message}` : typeof err,
          );
          result = { ...result, nextSyncToken: null, truncated: true };
        }
      }

      // Last occurrence of an id wins (pages can repeat an event that changed mid-walk).
      const mapped = new Map<string, ReturnType<typeof mapGoogleEvent>>();
      for (const ev of result.items) {
        const m = mapGoogleEvent(ev, detail, result.timeZone ?? "UTC", window);
        if (m && ev.id) mapped.set(importedEventDocId(subAccountId, uid, ev.id), m);
      }
      const existing = new Map<string, Record<string, unknown>>();
      if (full) {
        for (const d of await loadImported(subAccountId, uid)) existing.set(d.id, d.data());
      } else {
        const ids = [...mapped.keys()];
        for (let i = 0; i < ids.length; i += 100) {
          const snaps = await db.getAll(...ids.slice(i, i + 100).map((id) => db.collection("events").doc(id)));
          for (const s of snaps) if (s.exists) existing.set(s.id, s.data() as Record<string, unknown>);
        }
      }

      // Upcoming first, then the most recent past, so a crowded calendar keeps what is ahead.
      const upserts = [...mapped]
        .filter((e): e is [string, { kind: "upsert"; fields: ImportedFields }] => e[1]?.kind === "upsert")
        .sort(([, a], [, b]) => {
          const [ap, bp] = [a.fields.endAt.getTime() < now, b.fields.endAt.getTime() < now];
          if (ap !== bp) return ap ? 1 : -1;
          const d = a.fields.startAt.getTime() - b.fields.startAt.getTime();
          return ap ? -d : d;
        });
      const kept = upserts.slice(0, MAX_EVENTS_PER_MEMBER);
      const ctx = { agencyId: state.agencyId ?? "", subAccountId, uid, detail } as const;
      const ops: Op[] = [];
      let created = 0;
      for (const [id, m] of kept) {
        const doc = importedEventDoc(m.fields, ctx);
        const prev = existing.get(id);
        if (sameImport(prev, doc)) continue;
        const ref = db.collection("events").doc(id);
        // A whole-doc set, so nothing outside the import's shape survives a rewrite.
        const createdAt = prev?.createdAt ?? FieldValue.serverTimestamp();
        ops.push((tx) => tx.set(ref, { ...doc, createdAt, updatedAt: FieldValue.serverTimestamp() }));
        if (!prev) created++;
      }
      const keptIds = new Set(kept.map(([id]) => id));
      const doomed = new Set<string>();
      for (const [id, m] of mapped) if (m?.kind === "remove" && existing.has(id)) doomed.add(id);
      for (const [id] of upserts.slice(kept.length)) if (existing.has(id)) doomed.add(id);
      // Only a complete full walk proves absence.
      if (full && !result.truncated) for (const id of existing.keys()) if (!keptIds.has(id)) doomed.add(id);
      for (const id of doomed) ops.push((tx) => tx.delete(db.collection("events").doc(id)));

      for (let i = 0; i < ops.length; i += BATCH) {
        if (!(await commit(ops.slice(i, i + BATCH)))) {
          await enforceCurrentImportState(subAccountId, uid);
          return { ok: true, skipped: "settings_changed", full };
        }
      }

      // Only a full walk can tell whether the cap still bites; an incremental one keeps that notice.
      const importError = result.truncated
        ? PARTIAL_SYNC
        : full
          ? upserts.length > kept.length
            ? TOO_MANY
            : null
          : conn.importError === TOO_MANY
            ? TOO_MANY
            : null;
      // A truncated incremental walk keeps its old token so the missed pages come again.
      const token = result.truncated ? (full ? null : (conn.importSyncToken ?? null)) : result.nextSyncToken;
      const status: Record<string, unknown> = {
        importStatus: "ok",
        importError,
        importSyncToken: token,
        importedCount: full ? kept.length : Math.max(0, (conn.importedCount ?? 0) + created - doomed.size),
      };
      if (!(result.truncated && !full)) status.importLastSyncAt = new Date(now);
      if (full && !result.truncated) status.importLastFullSyncAt = new Date(now);
      if (!(await commit([(tx) => tx.update(connRef, status)]))) {
        await enforceCurrentImportState(subAccountId, uid);
        return { ok: true, skipped: "settings_changed", full };
      }
      return { ok: true, full, written: ops.length - doomed.size, deleted: doomed.size };
    } catch (err) {
      const error = describeFailure(err, "push");
      console.warn(
        `[google-calendar/import] sync failed sa=${subAccountId} uid=${uid}`,
        err instanceof Error ? `${err.name}: ${err.message}` : typeof err,
      );
      try {
        // Some batches may have landed; if a key moved meanwhile, its cleanup wins.
        if ((await readImportState(subAccountId, uid)).print !== state.print) {
          await enforceCurrentImportState(subAccountId, uid);
        } else {
          await connRef.update({ importStatus: "error", importError: error });
        }
      } catch (writeErr) {
        console.error(
          `[google-calendar/import] could not record failure sa=${subAccountId} uid=${uid}`,
          writeErr instanceof Error ? writeErr.message : String(writeErr),
        );
      }
      return { ok: false, full, error };
    }
  }
}

/** Give the lease back — only if it is still ours (an expired one may have been taken over). */
async function releaseLease(connRef: FirebaseFirestore.DocumentReference, leaseId: string): Promise<void> {
  try {
    await getAdminDb().runTransaction(async (tx) => {
      const c = await tx.get(connRef);
      if (c.exists && c.data()?.importLeaseId === leaseId) {
        tx.update(connRef, { importLeaseId: null, importLeaseUntil: null, importLeasePrint: null });
      }
    });
  } catch (err) {
    // It expires on its own (LEASE_MS); a disconnect meanwhile lands here too.
    console.warn("[google-calendar/import] lease release failed", err instanceof Error ? err.message : String(err));
  }
}

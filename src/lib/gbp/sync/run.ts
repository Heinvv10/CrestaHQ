import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { sentimentAfterSync } from "@/lib/reputation/sentiment";
import type { SubAccountDoc } from "@/types";
import { getGbpProviderFor } from "../provider/select";
import { GbpProviderError } from "../provider/types";
import { GbpNotConnectedError } from "../tokens";
import { acquireLease, commitGuarded, LeaseLostError, releaseLease, type GuardedOp } from "./lease";
import { fetchPass, type PassOutcome } from "./pass";
import { planReconcile, planRetention } from "./reconcile";
import { realSleep, type Sleep } from "./retry";
import { loadCache, tombstone } from "./store";
import { nextSummary } from "./summary";
import {
  DEFAULT_MAX_PAGES,
  reviewsCollection,
  runsCollection,
  syncStatePath,
  type GbpSummary,
  type SkipReason,
  type SyncRunRecord,
  type SyncState,
  type SyncTrigger,
} from "./types";

/**
 * `syncListing` — the ONE sync core. "Sync now" and the scheduled cron both
 * call it; they differ only in `trigger` (and the manual actor).
 *
 *   1. classify (gate, connection, listing, reconnect flag)
 *   2. lease — refused as `already_running`, or as `listing_changed` when the
 *      sub-account no longer matches what step 1 read
 *   3. retention (30-day policy) — on every run that holds the lease,
 *      including a retention-only run for a cache that can no longer sync
 *   4. fetch pages (resume / retry / stale-cursor restart) — see pass.ts
 *   5. outcome; reconciliation of a complete, authoritative pass
 *   6. summary, then the append-only run record
 *
 * Cached data is never deleted because a run failed — only by reconciliation
 * or by the retention policy.
 */

export interface SyncOptions {
  trigger: SyncTrigger;
  actorUid?: string | null;
  now?: Date;
  maxPages?: number;
  sleep?: Sleep;
  /** Wall clock for lease renewal; defaults to real time. */
  clock?: () => Date;
}

type SubWithSummary = SubAccountDoc & { gbpSummary?: GbpSummary | null };

export function skipReasonFor(sub: SubAccountDoc): SkipReason | null {
  if (sub.googleEnabledByAgency !== true) return "gate_off";
  if (!sub.googleConnectionMeta?.connected) return "not_connected";
  if (!sub.googleListing) return "no_listing";
  if (sub.googleConnectionMeta.reconnectRequired) return "reconnect_required";
  return null;
}

/** Map what stopped a pass to the run's status + errorKind; rethrow what is not a provider outcome. */
function classify(rec: SyncRunRecord, outcome: PassOutcome): void {
  const err = outcome.error;
  if (err instanceof LeaseLostError) throw err;
  if (err instanceof GbpNotConnectedError) {
    rec.status = "failed";
    rec.errorKind = "not_connected";
    return;
  }
  if (!(err instanceof GbpProviderError)) throw err;
  rec.errorKind = err.kind;
  if (err.kind === "revoked" || err.kind === "insufficient_scope") rec.status = "reconnect_required";
  else rec.status = outcome.pagesFetched > 0 ? "partial" : "failed";
  console.warn(`[gbp/sync] sa=${rec.subAccountId} run=${rec.runId} stopped kind=${err.kind} pages=${outcome.pagesFetched}`);
}

/** The summary this run continues from — only if it belongs to the same listing. */
function previousSummary(sub: SubWithSummary): GbpSummary | null {
  const s = sub.gbpSummary ?? null;
  if (!sub.googleListing) return s;
  return s?.locationName === sub.googleListing.locationName ? s : null;
}

async function runLeased(rec: SyncRunRecord, sub: SubWithSummary, state: SyncState, opts: SyncOptions, now: Date) {
  const sa = rec.subAccountId;
  const db = getAdminDb();
  const reviewRef = (id: string) => db.doc(`${reviewsCollection(sa)}/${id}`);
  const stateRef = db.doc(syncStatePath(sa));
  const subRef = db.doc(`subAccounts/${sa}`);
  const prev = previousSummary(sub);
  const retainOnly = rec.skipReason === "retention_only";
  const syncs = !retainOnly && (rec.skipReason === null || rec.skipReason === "reconnect_required");
  const cls = skipReasonFor(sub);
  const canSync = cls === null || cls === "reconnect_required";

  const cache = await loadCache(sa);
  const retention = planRetention(cache, prev, state.retentionPurgedAt, now);
  rec.purged = retention.remove.length;
  const purge: GuardedOp[] = retention.remove.map((id) => (tx) => tx.delete(reviewRef(id)));
  retention.remove.forEach((id) => cache.delete(id));
  if (retention.expired) {
    // Once: the purge restarts the retention clock, so later runs resume the
    // new pass instead of purging again (a big listing can finish).
    const reset = { retentionPurgedAt: now.getTime(), pass: null, anomalyStreak: null };
    purge.push((tx) => tx.set(stateRef, reset, { merge: true }));
  }
  if (!syncs && !canSync && cache.size === 0) {
    // A cache that can no longer sync drops its (Google-sourced) summary
    // once it holds no reviews — after an expiry purge, or when a
    // never-successful one has nothing left that could ever expire — and so
    // leaves the sweep's retention list.
    purge.push((tx) => tx.set(subRef, { gbpSummary: null }, { merge: true }));
  } else if (retainOnly && retention.expired) {
    // Housekeeping on a tenant that CAN sync: the expired rating/count go
    // too, and the summary says why (health error, retention_expired).
    const summary = nextSummary(rec, prev, { expired: true, rating: null }, now);
    purge.push((tx) => tx.set(subRef, { gbpSummary: summary }, { merge: true }));
  }
  await commitGuarded(sa, rec.runId, purge);
  if (!syncs) return;

  const finalOps: GuardedOp[] = [];
  let rating: { averageRating: number | null; totalReviewCount: number | null } | null = null;
  if (rec.skipReason === null) {
    const listing = sub.googleListing!;
    const outcome = await fetchPass({
      subAccountId: sa,
      runId: rec.runId,
      ref: { accountName: listing.accountName, locationName: listing.locationName },
      ctx: { agencyId: rec.agencyId, subAccountId: sa, createdByUid: rec.createdByUid, locationName: listing.locationName, now },
      cache,
      pass: retention.expired ? null : state.pass,
      maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES,
      sleep: opts.sleep ?? realSleep,
      clock: opts.clock ?? (() => new Date()),
    });
    Object.assign(rec, {
      pagesFetched: outcome.pagesFetched, reviewsSeen: outcome.reviewsSeen, created: outcome.created,
      updated: outcome.updated, unchanged: outcome.unchanged, resumedFromCursor: outcome.resumed,
    });
    rating = { averageRating: outcome.averageRating, totalReviewCount: outcome.totalReviewCount };
    if (outcome.error) classify(rec, outcome);
    else if (!outcome.complete) rec.status = "partial";
    else {
      const streak = retention.expired ? null : (state.anomalyStreak ?? null);
      const plan = planReconcile(cache, outcome.passId, !outcome.resumed, streak, now);
      rec.reconciliation = plan.reconciliation;
      rec.status = plan.reconciliation === "skipped_anomaly" ? "partial" : "success";
      rec.removed = plan.remove.length;
      for (const id of plan.remove) finalOps.push((tx) => tx.set(reviewRef(id), tombstone(now), { merge: true }));
      for (const [id, n] of plan.misses) finalOps.push((tx) => tx.set(reviewRef(id), { missedPasses: n }, { merge: true }));
      finalOps.push((tx) => tx.set(stateRef, { pass: null, anomalyStreak: plan.streak }, { merge: true }));
    }
  }
  const summary = nextSummary(rec, prev, { expired: retention.expired, rating }, now);
  finalOps.push((tx) => tx.set(subRef, { gbpSummary: summary }, { merge: true }));
  await commitGuarded(sa, rec.runId, finalOps);
}

/** Best effort after a non-provider failure: the summary must not keep saying "up to date". */
async function recordInternalFailure(rec: SyncRunRecord, sub: SubWithSummary, now: Date): Promise<void> {
  try {
    const summary = nextSummary(rec, previousSummary(sub), { expired: false, rating: null }, now);
    await commitGuarded(rec.subAccountId, rec.runId, [
      (tx) => tx.set(getAdminDb().doc(`subAccounts/${rec.subAccountId}`), { gbpSummary: summary }, { merge: true }),
    ]);
  } catch (e) {
    console.error(`[gbp/sync] sa=${rec.subAccountId} run=${rec.runId} summary not updated: ${e instanceof Error ? e.name : typeof e}`);
  }
}

function newRecord(subAccountId: string, sub: SubWithSummary, opts: SyncOptions, now: Date): SyncRunRecord {
  const listing = sub.googleListing ?? null;
  return {
    runId: getAdminDb().collection(runsCollection(subAccountId)).doc().id,
    agencyId: sub.agencyId,
    subAccountId,
    createdByUid: listing?.selectedByUid ?? opts.actorUid ?? null,
    trigger: opts.trigger,
    actorUid: opts.actorUid ?? null,
    startedAt: now,
    finishedAt: now,
    locationName: listing?.locationName ?? null,
    status: "skipped",
    pagesFetched: 0, reviewsSeen: 0, created: 0, updated: 0, unchanged: 0, removed: 0, purged: 0,
    reconciliation: "deferred",
    resumedFromCursor: false,
    errorKind: null,
    skipReason: skipReasonFor(sub),
  };
}

/**
 * Take the lease (refused if the sub-account no longer classifies as `cls`),
 * run, release. The run continues from the sub-account read INSIDE the lease.
 */
async function underLease(rec: SyncRunRecord, cls: SkipReason | null, opts: SyncOptions, now: Date, syncs: boolean) {
  const sa = rec.subAccountId;
  // Only a run that will fetch (and so commit review pages) stamps the marker.
  const stampIfAbsent: GbpSummary | undefined =
    rec.skipReason === null
      ? {
          locationName: rec.locationName ?? "", averageRating: null, totalReviewCount: null,
          lastSuccessfulSyncAt: null, lastRunAt: now, lastRunStatus: "running", lastErrorKind: null,
          lastReconciliation: null, health: "never_synced",
        }
      : undefined;
  const lease = await acquireLease(sa, rec.runId, now, {
    locationName: rec.locationName,
    skipReason: cls,
    classify: skipReasonFor,
    stampIfAbsent,
  });
  if (!lease.ok) {
    rec.skipReason = lease.reason;
    return;
  }
  try {
    await runLeased(rec, lease.sub as SubWithSummary, lease.state, opts, now);
  } catch (err) {
    rec.status = "failed";
    rec.errorKind = err instanceof LeaseLostError ? "lease_lost" : "internal";
    const reason = err instanceof Error ? err.name : typeof err;
    console.error(`[gbp/sync] sa=${sa} run=${rec.runId} ${rec.errorKind}: ${reason}`);
    if (syncs && rec.errorKind === "internal") await recordInternalFailure(rec, lease.sub as SubWithSummary, now);
  } finally {
    await releaseLease(sa, rec.runId);
  }
}

async function finish(rec: SyncRunRecord, opts: { now?: Date }, now: Date): Promise<SyncRunRecord> {
  rec.finishedAt = opts.now ? now : new Date();
  await getAdminDb().doc(`${runsCollection(rec.subAccountId)}/${rec.runId}`).create({ ...rec });
  return rec;
}

export async function syncListing(subAccountId: string, opts: SyncOptions): Promise<SyncRunRecord> {
  const now = opts.now ?? new Date();
  // The fence FIRST: in fake mode this throws for a sub-account outside the
  // fixture agency before anything of ours is read or written.
  await getGbpProviderFor(subAccountId);

  const sub = ((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubWithSummary;
  const rec = newRecord(subAccountId, sub, opts, now);
  // Syncable, reconnect-flagged (retention still runs), or holding a cache
  // that can no longer sync (retention only) → take the lease.
  const syncs = rec.skipReason === null || rec.skipReason === "reconnect_required";
  if (syncs || sub.gbpSummary) await underLease(rec, rec.skipReason, opts, now, syncs);
  // Sentiment (SP5 b) for what this run landed — best effort, its own lease,
  // never changes the sync's result. Absent from the record when it did not run.
  if (rec.pagesFetched > 0) {
    const sentiment = await sentimentAfterSync(subAccountId);
    if (sentiment) rec.sentiment = sentiment;
  }
  return finish(rec, opts, now);
}

/**
 * Retention ONLY — Google's 30-day rule for one sub-account's cache, sync-
 * eligible or not, under the same lease as a sync. Never reaches the
 * provider (not even getGbpProviderFor): the daily housekeeping cron, and the
 * sync cron while the sync schedule is off. Callers pick tenants from
 * fenced queries (sweep.ts), so fake mode still never touches a real tenant.
 */
export async function retainListing(subAccountId: string, opts: { now?: Date } = {}): Promise<SyncRunRecord> {
  const now = opts.now ?? new Date();
  const sub = ((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubWithSummary;
  const rec = newRecord(subAccountId, sub, { trigger: "scheduled" }, now);
  const cls = rec.skipReason;
  rec.skipReason = "retention_only";
  if (sub.gbpSummary) await underLease(rec, cls, { trigger: "scheduled" }, now, false);
  // Housekeeping leaves a record only when it did something (or failed), so
  // Recent syncs stays about real syncs.
  if (rec.purged === 0 && rec.status !== "failed") return rec;
  return finish(rec, opts, now);
}

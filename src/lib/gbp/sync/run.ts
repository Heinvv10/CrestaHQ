import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import { getGbpProviderFor } from "../provider/select";
import { GbpProviderError } from "../provider/types";
import { GbpNotConnectedError } from "../tokens";
import { deriveHealth } from "./health";
import { acquireLease, commitGuarded, LeaseLostError, releaseLease, type GuardedOp } from "./lease";
import { fetchPass, type PassOutcome } from "./pass";
import { planReconcile, planRetention } from "./reconcile";
import { realSleep, type Sleep } from "./retry";
import { loadCache, tombstone } from "./store";
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
 *   1. preconditions (gate, connection, listing, reconnect flag) → `skipped`
 *   2. lease, or `skipped already_running`
 *   3. retention (30-day policy) — on every run that holds the lease
 *   4. fetch pages (resume / retry / stale-cursor restart) — see pass.ts
 *   5. outcome, full-pass reconciliation with the anomaly guard
 *   6. summary, then the append-only run record
 *
 * Cached data is never deleted because a run failed — only by reconciliation
 * of a full pass, or by the retention policy.
 */

export interface SyncOptions {
  trigger: SyncTrigger;
  actorUid?: string | null;
  now?: Date;
  maxPages?: number;
  sleep?: Sleep;
}

type SubWithSummary = SubAccountDoc & { gbpSummary?: GbpSummary | null };

function skipReasonFor(sub: SubWithSummary): SkipReason | null {
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

function nextSummary(
  rec: SyncRunRecord,
  prev: GbpSummary | null,
  expired: boolean,
  lastPage: PassOutcome["lastPage"],
  now: Date,
): GbpSummary {
  const success = rec.status === "success";
  const keep = <K extends "averageRating" | "totalReviewCount">(k: K) => (expired ? null : (prev?.[k] ?? null));
  const summary: GbpSummary = {
    locationName: rec.locationName ?? "",
    averageRating: success ? (lastPage?.averageRating ?? null) : keep("averageRating"),
    totalReviewCount: success ? (lastPage?.totalReviewCount ?? null) : keep("totalReviewCount"),
    lastSuccessfulSyncAt: success ? now : (prev?.lastSuccessfulSyncAt ?? null),
    lastRunAt: now,
    lastRunStatus: rec.status,
    lastErrorKind: success
      ? null
      : expired
        ? "retention_expired"
        : rec.skipReason === "reconnect_required"
          ? "reconnect_required"
          : rec.errorKind,
    health: "never_synced",
  };
  summary.health = deriveHealth(summary, now);
  return summary;
}

async function runLeased(
  rec: SyncRunRecord,
  sub: SubWithSummary,
  state: SyncState,
  opts: SyncOptions,
  now: Date,
): Promise<void> {
  const sa = rec.subAccountId;
  const listing = sub.googleListing!;
  const db = getAdminDb();
  const reviewRef = (id: string) => db.doc(`${reviewsCollection(sa)}/${id}`);
  const stateRef = db.doc(syncStatePath(sa));
  const prev = sub.gbpSummary?.locationName === listing.locationName ? sub.gbpSummary : null;

  const cache = await loadCache(sa);
  const retention = planRetention(cache, prev, now);
  rec.purged = retention.remove.length;
  const purge: GuardedOp[] = retention.remove.map((id) => (tx) => tx.delete(reviewRef(id)));
  retention.remove.forEach((id) => cache.delete(id));
  await commitGuarded(sa, rec.runId, purge);

  const finalOps: GuardedOp[] = [];
  let lastPage: PassOutcome["lastPage"] = null;
  if (rec.skipReason === null) {
    const outcome = await fetchPass({
      subAccountId: sa,
      runId: rec.runId,
      ref: { accountName: listing.accountName, locationName: listing.locationName },
      ctx: { agencyId: rec.agencyId, subAccountId: sa, createdByUid: rec.createdByUid, locationName: listing.locationName, now },
      cache,
      // Expired: the cursor's pass refers to deleted content — start afresh.
      // (Every run stays expired until one succeeds, and success clears it.)
      pass: retention.expired ? null : state.pass,
      maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES,
      sleep: opts.sleep ?? realSleep,
    });
    Object.assign(rec, {
      pagesFetched: outcome.pagesFetched, reviewsSeen: outcome.reviewsSeen, created: outcome.created,
      updated: outcome.updated, unchanged: outcome.unchanged, resumedFromCursor: outcome.resumed,
    });
    lastPage = outcome.lastPage;
    if (outcome.error) classify(rec, outcome);
    else if (!outcome.complete) rec.status = "partial";
    else {
      const plan = planReconcile(cache, outcome.passId, outcome.lastPage?.totalReviewCount ?? null);
      rec.reconciliation = plan.anomaly ? "skipped_anomaly" : "full";
      rec.status = plan.anomaly ? "partial" : "success";
      rec.removed = plan.remove.length;
      for (const id of plan.remove) finalOps.push((tx) => tx.set(reviewRef(id), tombstone(now), { merge: true }));
      finalOps.push((tx) => tx.set(stateRef, { pass: null }, { merge: true }));
    }
  }
  const summary = nextSummary(rec, prev, retention.expired, lastPage, now);
  finalOps.push((tx) => tx.set(db.doc(`subAccounts/${sa}`), { gbpSummary: summary }, { merge: true }));
  await commitGuarded(sa, rec.runId, finalOps);
}

export async function syncListing(subAccountId: string, opts: SyncOptions): Promise<SyncRunRecord> {
  const now = opts.now ?? new Date();
  // The fence FIRST: in fake mode this throws for a sub-account outside the
  // fixture agency before anything of ours is read or written.
  await getGbpProviderFor(subAccountId);

  const db = getAdminDb();
  const sub = ((await db.doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubWithSummary;
  const listing = sub.googleListing ?? null;
  const rec: SyncRunRecord = {
    runId: db.collection(runsCollection(subAccountId)).doc().id,
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

  // A flagged connection still runs retention (under the lease); the rest
  // have no listing cache to look after, or a gate that says hands off.
  if (rec.skipReason === null || rec.skipReason === "reconnect_required") {
    const state = await acquireLease(subAccountId, rec.runId, now);
    if (!state) {
      rec.status = "skipped";
      rec.skipReason = "already_running";
    } else {
      try {
        await runLeased(rec, sub, state, opts, now);
      } catch (err) {
        rec.status = "failed";
        rec.errorKind = err instanceof LeaseLostError ? "lease_lost" : "internal";
        const reason = err instanceof Error ? err.name : typeof err;
        console.error(`[gbp/sync] sa=${subAccountId} run=${rec.runId} ${rec.errorKind}: ${reason}`);
      } finally {
        await releaseLease(subAccountId, rec.runId);
      }
    }
  }

  rec.finishedAt = opts.now ? now : new Date();
  await db.doc(`${runsCollection(subAccountId)}/${rec.runId}`).create({ ...rec });
  return rec;
}

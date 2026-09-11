import { ANOMALY_CONFIRMATIONS, RETENTION_MS, toMillis, type GbpSummary, type Reconciliation, type SyncState } from "./types";
import type { CachedReview } from "./store";

/**
 * The decisions that DELETE or HIDE cached reviews, kept pure so each rule is
 * a readable function and every branch is unit-testable through the core.
 */

type Streak = NonNullable<SyncState["anomalyStreak"]> | null;

/**
 * After a COMPLETE pass: every active review the pass did not see was removed
 * at Google — but only when the pass is authoritative:
 *
 *   - One run: the pass started AND finished within a single run. Google
 *     pages by `updateTime desc`, so a pass spread over several runs can miss
 *     a review edited in between (it moved to an already-fetched page), and
 *     no count can tell: reviews arriving meanwhile inflate what a resumed
 *     pass sees. So a resumed pass removes nothing (`deferred`); removals on
 *     a listing too big for one run rely on the 30-day rule instead.
 *   - Anomaly: a pass that saw nothing while Google still reports reviews,
 *     or that would remove more than half of ten or more active reviews,
 *     looks like an outage, so nothing is removed (`skipped_anomaly`) — until the
 *     third consecutive complete pass plans the same removal count, which is
 *     then applied (`full_after_anomaly`). A deferred pass leaves the streak.
 */
export function planReconcile(
  cache: Map<string, CachedReview>,
  passId: string,
  singleRun: boolean,
  totalReviewCount: number | null,
  streak: Streak,
): { reconciliation: Reconciliation; remove: string[]; streak: Streak } {
  if (!singleRun) return { reconciliation: "deferred", remove: [], streak };
  const active = [...cache].filter(([, c]) => c.state === "active");
  const seen = active.filter(([, c]) => c.passId === passId).length;
  const remove = active.filter(([, c]) => c.passId !== passId).map(([id]) => id);
  const anomaly =
    (seen === 0 && (totalReviewCount ?? 0) > 0) ||
    (active.length >= 10 && remove.length * 2 > active.length);
  if (!anomaly) return { reconciliation: "full", remove, streak: null };
  const count = streak?.removals === remove.length ? streak.count + 1 : 1;
  if (count >= ANOMALY_CONFIRMATIONS) return { reconciliation: "full_after_anomaly", remove, streak: null };
  return { reconciliation: "skipped_anomaly", remove: [], streak: { removals: remove.length, count } };
}

/** When the retention clock last restarted: the later of a success and a full purge. */
export function retentionBasis(
  summary: Pick<GbpSummary, "lastSuccessfulSyncAt"> | null | undefined,
  retentionPurgedAt: number | null | undefined,
): number | null {
  const last = toMillis(summary?.lastSuccessfulSyncAt);
  const purged = retentionPurgedAt ?? null;
  if (last === null) return purged;
  return purged === null ? last : Math.max(last, purged);
}

/** Read-time rule too (the reviews route, PR 3's feed): may this review be shown at all? */
export function withinRetention(lastSeenAt: unknown, now: Date): boolean {
  const seen = toMillis(lastSeenAt);
  return seen !== null && now.getTime() - seen <= RETENTION_MS;
}

/**
 * Google's policy: content is stored "for no more than 30 calendar days".
 *   - a review not re-seen for 30 days (or with no lastSeenAt) is deleted
 *     outright, not tombstoned;
 *   - if nothing has synced successfully for 30 days — counted from the later
 *     of the last success and the last full purge — ALL cached content goes
 *     (`expired`), ONCE: the purge restarts the clock, so a listing too big for
 *     one run can then finish its new pass.
 */
export function planRetention(
  cache: Map<string, CachedReview>,
  summary: Pick<GbpSummary, "lastSuccessfulSyncAt"> | null | undefined,
  retentionPurgedAt: number | null | undefined,
  now: Date,
): { expired: boolean; remove: string[] } {
  const basis = retentionBasis(summary, retentionPurgedAt);
  const expired = basis !== null && now.getTime() - basis > RETENTION_MS;
  const remove = [...cache]
    .filter(([, c]) => expired || !withinRetention(c.lastSeenAt, now))
    .map(([id]) => id);
  return { expired, remove };
}

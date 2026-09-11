import { RETENTION_MS, toMillis, type GbpSummary } from "./types";
import type { CachedReview } from "./store";

/**
 * The two decisions that DELETE or HIDE cached reviews, kept pure so each
 * rule is a readable function and every branch is unit-testable.
 */

/**
 * After a FULL pass: every active review this pass did not see was removed at
 * Google. Unless the result looks like an outage rather than removals:
 *   - the pass saw nothing while Google still reports reviews, or
 *   - it would remove more than half of ten or more active reviews.
 * Then nothing is removed and the caller records `skipped_anomaly`.
 */
export function planReconcile(
  cache: Map<string, CachedReview>,
  passId: string,
  totalReviewCount: number | null,
): { anomaly: boolean; remove: string[] } {
  const active = [...cache].filter(([, c]) => c.state === "active");
  const seen = active.filter(([, c]) => c.passId === passId).length;
  const remove = active.filter(([, c]) => c.passId !== passId).map(([id]) => id);
  const anomaly =
    (seen === 0 && (totalReviewCount ?? 0) > 0) ||
    (active.length >= 10 && remove.length * 2 > active.length);
  return { anomaly, remove: anomaly ? [] : remove };
}

/**
 * Google's policy: content is stored "for no more than 30 calendar days".
 *   - a review not re-seen for 30 days is deleted outright (not tombstoned);
 *   - if nothing has synced successfully for 30 days, ALL cached content goes
 *     (`expired`) — whatever this run's outcome turns out to be.
 */
export function planRetention(
  cache: Map<string, CachedReview>,
  summary: Pick<GbpSummary, "lastSuccessfulSyncAt"> | null | undefined,
  now: Date,
): { expired: boolean; remove: string[] } {
  const last = toMillis(summary?.lastSuccessfulSyncAt);
  const expired = last !== null && now.getTime() - last > RETENTION_MS;
  const remove = [...cache]
    .filter(([, c]) => expired || (c.lastSeenAt !== null && now.getTime() - c.lastSeenAt > RETENTION_MS))
    .map(([id]) => id);
  return { expired, remove };
}

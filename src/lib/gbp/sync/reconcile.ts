import {
  ANOMALY_CONFIRMATIONS,
  ANOMALY_CONFIRMATION_GAP_MS,
  MISSES_TO_REMOVE,
  RETENTION_MS,
  toMillis,
  type GbpSummary,
  type Reconciliation,
  type SyncState,
} from "./types";
import type { CachedReview } from "./store";

/**
 * The decisions that DELETE or HIDE cached reviews, kept pure so each rule is
 * a readable function and every branch is unit-testable through the core.
 */

type Streak = NonNullable<SyncState["anomalyStreak"]> | null;

/**
 * After a COMPLETE pass, per review:
 *
 *   - Only a pass that started AND finished in ONE run counts misses. Google
 *     pages by offset under `updateTime desc`, so a review edited or deleted
 *     mid-pass shifts the pages and a live review can go unseen; a resumed
 *     pass is even less reliable. A resumed pass counts nothing (`deferred`).
 *   - A counted pass adds one miss to every active review it did not see
 *     (seeing a review resets it to 0 — see store.ts). A review is tombstoned
 *     only at {@link MISSES_TO_REMOVE} consecutive misses: one bad pass can
 *     hide a live review, it cannot remove it.
 *   - Anomaly brake on top: planned tombstones from a pass that saw nothing,
 *     or more than half of ten or more active reviews, look like an outage —
 *     held back (`skipped_anomaly`) until the third such pass with the same
 *     count, each confirmation at least an hour after the last
 *     (`full_after_anomaly`). A different count restarts the streak.
 *
 * `misses` are the new miss counts to write for unseen reviews that stay.
 */
export function planReconcile(
  cache: Map<string, CachedReview>,
  passId: string,
  singleRun: boolean,
  streak: Streak,
  now: Date,
): { reconciliation: Reconciliation; remove: string[]; misses: Array<[string, number]>; streak: Streak } {
  if (!singleRun) return { reconciliation: "deferred", remove: [], misses: [], streak };
  const active = [...cache].filter(([, c]) => c.state === "active");
  const seen = active.filter(([, c]) => c.passId === passId).length;
  const unseen = active.filter(([, c]) => c.passId !== passId).map(([id, c]) => [id, (c.missedPasses ?? 0) + 1] as [string, number]);
  const due = unseen.filter(([, n]) => n >= MISSES_TO_REMOVE).map(([id]) => id);
  const keep = (ids: string[]) => unseen.filter(([id]) => !ids.includes(id));
  const anomaly =
    (seen === 0 && due.length > 0) || (active.length >= 10 && due.length * 2 > active.length);
  if (!anomaly) return { reconciliation: "full", remove: due, misses: keep(due), streak: null };

  const nowMs = now.getTime();
  const same = streak?.removals === due.length;
  const confirms = !same || nowMs - streak.lastAt >= ANOMALY_CONFIRMATION_GAP_MS;
  const next: Streak = same
    ? (confirms ? { removals: due.length, count: streak.count + 1, lastAt: nowMs } : streak)
    : { removals: due.length, count: 1, lastAt: nowMs };
  if (next.count >= ANOMALY_CONFIRMATIONS) {
    return { reconciliation: "full_after_anomaly", remove: due, misses: keep(due), streak: null };
  }
  return { reconciliation: "skipped_anomaly", remove: [], misses: unseen, streak: next };
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

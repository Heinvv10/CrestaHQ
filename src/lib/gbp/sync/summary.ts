import { deriveHealth } from "./health";
import { RETENTION_MS, toMillis, type GbpSummary, type SyncRunRecord } from "./types";

/**
 * The member-readable summary a run leaves behind. Rating and count change
 * only on success (from the pass's first non-null values — never invented,
 * never a later page's null). Every writer goes through here, and none may
 * carry forward a rating/count whose last success is older than Google's
 * 30-day limit — whether or not this run purged (a failure after the purge,
 * or the sweep's failure record, would otherwise re-store it).
 */
export function nextSummary(
  rec: SyncRunRecord,
  prev: GbpSummary | null,
  opts: { expired: boolean; rating: { averageRating: number | null; totalReviewCount: number | null } | null },
  now: Date,
): GbpSummary {
  const success = rec.status === "success";
  const lastSuccess = toMillis(prev?.lastSuccessfulSyncAt);
  const stale = opts.expired || (lastSuccess !== null && now.getTime() - lastSuccess > RETENTION_MS);
  const keep = <K extends "averageRating" | "totalReviewCount">(k: K) => (stale ? null : (prev?.[k] ?? null));
  const summary: GbpSummary = {
    locationName: rec.locationName ?? "",
    averageRating: success ? (opts.rating?.averageRating ?? null) : keep("averageRating"),
    totalReviewCount: success ? (opts.rating?.totalReviewCount ?? null) : keep("totalReviewCount"),
    lastSuccessfulSyncAt: success ? now : (prev?.lastSuccessfulSyncAt ?? null),
    lastRunAt: now,
    lastRunStatus: rec.status,
    lastErrorKind: success
      ? null
      : opts.expired
        ? "retention_expired"
        : rec.skipReason === "reconnect_required"
          ? "reconnect_required"
          : rec.errorKind,
    lastReconciliation: rec.reconciliation,
    health: "never_synced",
  };
  summary.health = deriveHealth(summary, now);
  return summary;
}

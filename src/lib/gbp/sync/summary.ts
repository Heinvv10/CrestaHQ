import { deriveHealth } from "./health";
import type { GbpSummary, SyncRunRecord } from "./types";

/**
 * The member-readable summary a run leaves behind. Rating and count change
 * only on success (from the pass's first non-null values — never invented,
 * never a later page's null); an expired-retention purge takes them away.
 */
export function nextSummary(
  rec: SyncRunRecord,
  prev: GbpSummary | null,
  opts: { expired: boolean; rating: { averageRating: number | null; totalReviewCount: number | null } | null },
  now: Date,
): GbpSummary {
  const success = rec.status === "success";
  const keep = <K extends "averageRating" | "totalReviewCount">(k: K) => (opts.expired ? null : (prev?.[k] ?? null));
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

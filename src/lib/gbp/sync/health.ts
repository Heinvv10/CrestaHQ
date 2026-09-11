import {
  RETENTION_MS,
  STALE_AFTER_MS,
  toMillis,
  type GbpHealth,
  type GbpSummary,
} from "./types";

/**
 * The one definition of sync health, re-derived against the CURRENT clock
 * wherever it is shown (API, UI) — a summary written at the last run says
 * nothing about how old that run is now. We poll every 6 hours; nothing here
 * ever claims "live".
 */
export function deriveHealth(summary: GbpSummary | null | undefined, now: Date): GbpHealth {
  if (!summary) return "never_synced";
  if (summary.lastErrorKind === "retention_expired") return "error";
  if (
    summary.lastRunStatus === "reconnect_required" ||
    summary.lastErrorKind === "reconnect_required"
  ) {
    return "reconnect_required";
  }
  const last = toMillis(summary.lastSuccessfulSyncAt);
  if (last === null) {
    if (summary.lastRunStatus === "partial") return "partial";
    return summary.lastRunStatus === "failed" ? "error" : "never_synced";
  }
  const age = now.getTime() - last;
  if (age > RETENTION_MS) return "error";
  if (summary.lastRunStatus === "failed") return "stale";
  if (summary.lastRunStatus === "partial") return "partial";
  if (age > STALE_AFTER_MS) return "stale";
  return "ok";
}

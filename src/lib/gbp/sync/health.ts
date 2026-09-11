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
 * nothing about how old that run is now. We poll; nothing here ever claims
 * "live".
 *
 * With `live` (the sub-account's CURRENT connection meta), the connection
 * wins: flagged → reconnect_required whatever the last run said; reconnected
 * since a run that needed it → sync_pending, so the page never keeps saying
 * "revoked" after the admin fixed it.
 */
export function deriveHealth(
  summary: GbpSummary | null | undefined,
  now: Date,
  live?: { reconnectRequired?: boolean | null },
): GbpHealth {
  if (live?.reconnectRequired) return "reconnect_required";
  if (!summary) return "never_synced";
  if (summary.lastErrorKind === "retention_expired") return "error";
  if (
    summary.lastRunStatus === "reconnect_required" ||
    summary.lastErrorKind === "reconnect_required"
  ) {
    return live ? "sync_pending" : "reconnect_required";
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

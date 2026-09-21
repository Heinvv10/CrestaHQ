/**
 * Whether this deployment runs the 6-hourly GBP sync schedule. Opt-in: the
 * schedule is registered (register-schedules.ts) and the page says "Syncs
 * automatically every 6 hours" ONLY when `GBP_SYNC_SCHEDULE_ENABLED === "1"`;
 * otherwise the page tells the truth — only Sync now runs.
 */
export function gbpSyncScheduled(): boolean {
  return process.env.GBP_SYNC_SCHEDULE_ENABLED === "1";
}

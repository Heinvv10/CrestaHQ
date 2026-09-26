import "server-only";

import { autoReplyAfterSync } from "./auto-reply/run";
import { afterResponse, classifySyncedRuns, type SyncedRun } from "./sentiment-after";

/**
 * What runs AFTER a sync route has answered (cron gbp-sync and manual "Sync
 * now"), one request's tenants under its ONE deadline: review auto-reply for
 * every synced tenant FIRST — bounded by its daily caps — then sentiment, so
 * a large sentiment catch-up cannot starve a later tenant's replies
 * (AUTO_REPLY_V1_PLAN.md). Auto-reply is inert unless the deployment's
 * `REVIEWS_AUTO_REPLY_ENABLED` kill switch is set. Never inside the sync.
 */
export async function runAfterSync(runs: SyncedRun[], deadline: number): Promise<void> {
  for (const run of runs) await autoReplyAfterSync(run.subAccountId, run.startedAt, deadline);
  await classifySyncedRuns(runs, deadline);
}

export function afterSyncResponse(runs: SyncedRun[], deadline: number): void {
  if (!runs.length) return;
  afterResponse(() => runAfterSync(runs, deadline));
}

import "server-only";

import { after } from "next/server";
import { classifyPendingSentiment } from "./sentiment";
import { readLeaseDoc } from "./sentiment-lease";

/**
 * Sentiment never runs inside a sync (Cloudflare cuts origin requests at
 * 100 s and QStash would retry a slow cron). The sync routes hand the runs
 * they made to `classifyAfterResponse`, which runs AFTER the response via
 * Next's `after()`; outside a request scope (tests, scripts) `after` throws
 * and the work runs detached instead — same pattern as google-calendar/push.ts.
 */

export interface SyncedRun {
  subAccountId: string;
  created: number;
  updated: number;
}

/**
 * Classify after a sync only when it can matter: the run created or changed
 * reviews, or the last classification left something (or never ran / was
 * skipped — the pending hint is then unknown). One small read otherwise.
 */
export async function classifyAfterSync(run: SyncedRun): Promise<void> {
  try {
    if (run.created + run.updated === 0) {
      const { pending } = await readLeaseDoc(run.subAccountId);
      if (pending === 0) return;
    }
    await classifyPendingSentiment(run.subAccountId);
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${run.subAccountId} after-sync failed kind=${err instanceof Error ? err.name : typeof err}`);
  }
}

/** Run `work` after the response; detached when there is no request scope. */
export function afterResponse(work: () => Promise<unknown>): void {
  try {
    after(work);
  } catch {
    void work();
  }
}

/** The sync routes: classify each run's tenant, one after another, after responding. */
export function classifyAfterResponse(runs: SyncedRun[]): void {
  if (!runs.length) return;
  afterResponse(async () => {
    for (const run of runs) await classifyAfterSync(run);
  });
}

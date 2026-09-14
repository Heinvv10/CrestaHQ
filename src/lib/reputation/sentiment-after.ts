import "server-only";

import { after } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { reviewsAiConfigured } from "./ai/mode";
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

/** A completed run older than this is re-done after a sync even if nothing changed. */
export const SENTIMENT_RECHECK_MS = 24 * 3600_000;

const kind = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * Classify after a sync iff Reviews AI can run for the tenant (both gates
 * on, AI configured) AND the run created or changed reviews, or no run has
 * completed normally in the last 24 h (a killed or stopped run, items
 * waiting out their retry hour, a gate just switched on). Otherwise nothing
 * beyond the sub-account read; Analyse now covers "right now".
 */
export async function classifyAfterSync(run: SyncedRun): Promise<void> {
  try {
    const sub = (await getAdminDb().doc(`subAccounts/${run.subAccountId}`).get()).data() ?? {};
    if (sub.reviewsAiEnabledByAgency !== true || sub.googleEnabledByAgency !== true || !reviewsAiConfigured()) return;
    if (run.created + run.updated === 0) {
      const { lastCompleteAt } = await readLeaseDoc(run.subAccountId);
      if (typeof lastCompleteAt === "number" && Date.now() - lastCompleteAt < SENTIMENT_RECHECK_MS) return;
    }
    await classifyPendingSentiment(run.subAccountId);
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${run.subAccountId} after-sync failed kind=${kind(err)}`);
  }
}

/** Run `work` after the response; detached (and said so) when there is no request scope. */
export function afterResponse(work: () => Promise<unknown>): void {
  try {
    after(work);
  } catch {
    console.warn("[reputation/sentiment] no request scope for after(); running detached");
    void work().catch((err) => console.warn(`[reputation/sentiment] detached work failed kind=${kind(err)}`));
  }
}

/** The sync routes: classify each run's tenant, one after another, after responding. */
export function classifyAfterResponse(runs: SyncedRun[]): void {
  if (!runs.length) return;
  afterResponse(async () => {
    for (const run of runs) await classifyAfterSync(run);
  });
}

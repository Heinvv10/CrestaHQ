import "server-only";

import { after } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { reviewsAiConfigured } from "./ai/mode";
import { classifyPendingSentiment, SENTIMENT_RUN_BUDGET_MS } from "./sentiment";
import { readLeaseDoc } from "./sentiment-lease";

/**
 * Sentiment never runs inside a sync (Cloudflare cuts origin requests at
 * 100 s and QStash would retry a slow cron). The sync routes hand the runs
 * they made to `afterSyncResponse` (after-sync.ts — auto-reply first, then
 * `classifySyncedRuns`), which runs AFTER the response via Next's `after()`; outside a request scope (tests, scripts) `after` throws
 * and the work runs detached instead — same pattern as google-calendar/push.ts.
 */

export interface SyncedRun {
  subAccountId: string;
  created: number;
  updated: number;
  /** The sync run's start: a review with `lastSeenAt >= startedAt` was seen by it (auto-reply). */
  startedAt: Date;
}

/** After a sync that changed nothing, classify again once the last complete run is older than this. */
export const SENTIMENT_RECHECK_MS = 24 * 3600_000;

const kind = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * Classify after a sync iff Reviews AI can run for the tenant (both gates
 * on, AI configured) AND either the run created or changed reviews, or the
 * last COMPLETE run (`lastCompleteAt`) is more than 24 h old or there has
 * been none — which covers a killed, stopped or capped run, items waiting out
 * their retry hour, and the gate just switched on (switching it on clears
 * `lastCompleteAt`). Otherwise nothing beyond the sub-account read; Analyse
 * now covers "right now". `deadline` is shared by every tenant of one request.
 */
export async function classifyAfterSync(run: Omit<SyncedRun, "startedAt">, deadline: number): Promise<void> {
  try {
    const sub = (await getAdminDb().doc(`subAccounts/${run.subAccountId}`).get()).data() ?? {};
    if (sub.reviewsAiEnabledByAgency !== true || sub.googleEnabledByAgency !== true || !reviewsAiConfigured()) return;
    if (run.created + run.updated === 0) {
      const { lastCompleteAt } = await readLeaseDoc(run.subAccountId);
      if (typeof lastCompleteAt === "number" && Date.now() - lastCompleteAt < SENTIMENT_RECHECK_MS) return;
    }
    await classifyPendingSentiment(run.subAccountId, { deadline });
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

/** A request's deadline: its start + 240 s, one for every tenant it classifies (routes allow 300 s). */
export const requestDeadline = (startedAt = Date.now()) => startedAt + SENTIMENT_RUN_BUDGET_MS;

/** Each run's tenant, one after another, all under the one `deadline`. */
export async function classifySyncedRuns(runs: Omit<SyncedRun, "startedAt">[], deadline: number): Promise<void> {
  for (const run of runs) await classifyAfterSync(run, deadline);
}

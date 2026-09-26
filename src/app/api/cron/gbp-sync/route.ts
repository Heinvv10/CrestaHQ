import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { gbpSyncScheduled } from "@/lib/gbp/sync/schedule";
import { runGbpRetentionSweep, runGbpSyncSweep } from "@/lib/gbp/sync/sweep";
import { afterSyncResponse } from "@/lib/reputation/after-sync";
import { requestDeadline, type SyncedRun } from "@/lib/reputation/sentiment-after";

/**
 * Scheduled Google Business Profile review sync — every 6 hours.
 *
 * Public path — the QStash signature is the authentication, as for every
 * other cron route here, and it is bound to THIS route: it must have been
 * minted for `${NEXT_PUBLIC_APP_URL}/api/cron/gbp-sync` (the schedule's
 * destination), so another route's signed call cannot be replayed here.
 *
 * The schedule is opt-in (`GBP_SYNC_SCHEDULE_ENABLED=1`, registered by
 * register-schedules.ts). With the flag off this answers 200
 * `{skipped:"not_scheduled", …}` and syncs nobody — so a schedule left behind
 * in QStash cannot make the page's "not scheduled" untrue — and runs the same
 * retention-only pass as the always-on daily `gbp-retention` cron (every
 * tenant holding a cache, no provider calls).
 *
 * Review auto-reply (AUTO_REPLY_V1_PLAN.md; inert unless
 * REVIEWS_AUTO_REPLY_ENABLED is set) and then review sentiment (SP5 b) run
 * AFTER this responds, one tenant after another under ONE deadline (request
 * start + 240 s) — auto-reply for every synced tenant first; sentiment only
 * for tenants with Reviews AI on whose run changed reviews or whose last
 * complete classification is over 24 h old — never inside the request
 * (QStash would retry a slow cron).
 *
 * Each sub-account is isolated inside the sweep, so this answers 200 with the
 * tally even when some tenants failed; 500 only when the sweep could not
 * start at all, so QStash retries.
 */

export const dynamic = "force-dynamic";
/** Auto-reply + sentiment run after the response inside this invocation (budget 240 s). */
export const maxDuration = 300;

export async function POST(request: Request) {
  const deadline = requestDeadline();
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/gbp-sync` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    if (gbpSyncScheduled()) {
      const runs: SyncedRun[] = [];
      const result = await runGbpSyncSweep({
        onRun: (r) => runs.push({ subAccountId: r.subAccountId, created: r.created, updated: r.updated, startedAt: r.startedAt }),
      });
      afterSyncResponse(runs, deadline);
      return NextResponse.json(result);
    }
    // Flag off: behave exactly like the daily retention cron (every tenant
    // holding a cache, no provider calls) and sync nobody.
    return NextResponse.json({ skipped: "not_scheduled", processed: 0, ...(await runGbpRetentionSweep()) });
  } catch (err) {
    console.error("[cron/gbp-sync] sweep failed", err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

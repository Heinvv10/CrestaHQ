import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runGbpRetentionSweep } from "@/lib/gbp/sync/sweep";

/**
 * Daily Google Business Profile review-cache retention — always on.
 *
 * Google's content policy caps storage at 30 calendar days, and that must not
 * depend on whether the review SYNC is scheduled (`GBP_SYNC_SCHEDULE_ENABLED`
 * controls only the Google sync). So this job runs daily and unconditionally
 * as part of `/api/cron/daily-housekeeping` (03:00 UTC): a retention-only
 * pass for EVERY sub-account holding a cache — sync-eligible or not. Firestore only: it never reaches the provider.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. 500 only when the sweep cannot start, so QStash retries.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/gbp-retention` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    return NextResponse.json(await runGbpRetentionSweep());
  } catch (err) {
    console.error("[cron/gbp-retention] sweep failed", err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

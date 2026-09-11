import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runGbpSyncSweep } from "@/lib/gbp/sync/sweep";

/**
 * Scheduled Google Business Profile review sync — every 6 hours.
 *
 * Public path — the QStash signature is the authentication, as for every
 * other cron route here. The schedule is NOT auto-registered
 * (register-schedules.ts): creating it is an owner-approval step, documented
 * in docs/features/gbp-reviews.md.
 *
 * Each sub-account is isolated inside the sweep, so this answers 200 with the
 * tally even when some tenants failed; 500 only when the sweep could not
 * start at all, so QStash retries.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    return NextResponse.json(await runGbpSyncSweep());
  } catch (err) {
    console.error("[cron/gbp-sync] sweep failed", err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

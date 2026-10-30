import "server-only";

import { NextResponse } from "next/server";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import {
  collectHeartbeatStats,
  sendHeartbeat,
} from "@/lib/gitpage/heartbeat";

export const dynamic = "force-dynamic";

/**
 * Daily QStash callback that sends a fuller heartbeat — same payload as
 * the boot ping plus subAccountCount and buildsLastDay so gitpage can see
 * usage telemetry rather than just liveness.
 *
 * Scheduled as a job of `/api/cron/daily-housekeeping` (03:00 UTC); this
 * route runs it by hand.
 *
 * The middleware lets this path through unauthenticated; security comes
 * from QStash's Upstash-Signature header.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const stats = await collectHeartbeatStats();
  const result = await sendHeartbeat(stats);

  return NextResponse.json({
    ok: true,
    sent: result !== null,
    agency: result?.gitpageStatus?.agency ?? null,
  });
}

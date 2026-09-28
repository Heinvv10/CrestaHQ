import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { sweepReportAnnounces } from "@/lib/prospecting/announce-sweep";

/**
 * Prospect report announce sweep — QStash schedule
 * `leadstack-prospect-announce`, every 15 minutes (96 messages a day per
 * deployment). See lib/prospecting/announce-sweep.ts.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. 500 when the sweep throws, so QStash retries.
 */

export const dynamic = "force-dynamic";

const PATH = "/api/automations/prospecting/announce-sweep";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl || !(await verifyQStashSignature(signature, rawBody, `${appUrl}${PATH}`))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await sweepReportAnnounces()) });
  } catch (err) {
    console.error("[prospecting/announce-sweep] sweep failed", err);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

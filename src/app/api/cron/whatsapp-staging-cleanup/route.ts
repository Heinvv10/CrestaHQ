import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { sweepStaleStaged } from "@/lib/comms/whatsapp/staged-upload";

/**
 * Daily sweep of abandoned WhatsApp composer uploads (`whatsapp-staging/`
 * objects over an hour old): files attached and never sent. The send route
 * deletes its own staged object; this catches the rest.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. 500 only when the sweep cannot run, so QStash retries.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/whatsapp-staging-cleanup` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    return NextResponse.json(await sweepStaleStaged());
  } catch (err) {
    console.error("[cron/whatsapp-staging-cleanup] sweep failed", err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

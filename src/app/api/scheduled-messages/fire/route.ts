import "server-only";

import { NextResponse } from "next/server";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { fireScheduledMessage } from "@/lib/server/scheduled-messages/fire";

export const dynamic = "force-dynamic";

/**
 * Scheduled-message worker (SP2 T5) — QStash callback published by
 * POST /api/sub-accounts/[id]/scheduled-messages at the message's sendAt.
 * Public path; security is the Upstash signature, verified exactly as the
 * workflow step worker does. Idempotent (fireScheduledMessage claims the
 * message before sending), so a redelivery is a no-op. Every outcome after the
 * claim answers 200: a retry could not do anything but skip.
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
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { contactId?: unknown; scheduledMessageId?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { contactId, scheduledMessageId } = payload ?? {};
  if (
    typeof contactId !== "string" ||
    typeof scheduledMessageId !== "string" ||
    !contactId ||
    !scheduledMessageId ||
    contactId.includes("/") ||
    scheduledMessageId.includes("/")
  ) {
    return NextResponse.json(
      { error: "Body must include contactId + scheduledMessageId" },
      { status: 400 },
    );
  }

  try {
    const result = await fireScheduledMessage(contactId, scheduledMessageId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Only reachable before the claim commits (or while writing the outcome),
    // so a QStash retry either claims it now or finds it no longer pending.
    console.error("[scheduled-messages/fire] threw", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Fire failed" },
      { status: 500 },
    );
  }
}

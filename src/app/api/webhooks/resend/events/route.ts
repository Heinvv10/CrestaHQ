import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { readBodyCapped } from "@/lib/api/body-limit";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  handleResendDeliveryEvent,
  isTrackedEmailEvent,
  type ResendDeliveryEvent,
} from "@/lib/comms/email-events";
import { resendWebhookKey, verifySvixRequest } from "@/lib/comms/resend-webhook";

export const dynamic = "force-dynamic";

/**
 * A delivery event is a few hundred bytes of metadata; 64 KB bounds what an
 * unauthenticated caller can make this route buffer and hash.
 */
const MAX_EVENT_BYTES = 64 * 1024;

/**
 * `resendWebhookDeliveries/{svix-id}` marks a message processed. It outlives
 * the ±5 minute signature window many times over, so a captured request
 * can never be replayed while it still verifies.
 */
const DELIVERIES = "resendWebhookDeliveries";
const DELIVERY_MARKER_TTL_MS = 24 * 3_600_000;

/**
 * Resend events webhook — delivered / opened / clicked / bounced /
 * complained for broadcast emails sent through Resend (buyer copies; a
 * deployment on per-sub-account SMTP gets no events). One Resend account per
 * deployment, so one endpoint and one secret; each event resolves to its
 * tenant through the `emailEvents` lookup the send step wrote, never through
 * anything in the body (lib/comms/email-events.ts).
 *
 * Fails closed: 503 with no RESEND_WEBHOOK_SECRET, 413 over the cap (checked
 * before hashing), 401 on a missing, wrong or stale Svix signature; a
 * svix-id already processed is acknowledged 200 `{ignored: true}`. None of
 * these writes anything, nor does a verified body that is not JSON or not a
 * tracked event type (200 ignored). A verified event we could not process —
 * including one for a row the step has not settled yet — deletes its marker
 * and answers 500, so Resend's retry runs it again. Everything else answers
 * 200, so Resend doesn't retry-storm.
 */
export async function POST(request: Request) {
  const key = resendWebhookKey();
  if (!key) {
    return NextResponse.json({ error: "Resend webhook is not configured." }, { status: 503 });
  }
  const rawBody = await readBodyCapped(request, MAX_EVENT_BYTES);
  if (rawBody === null) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }
  const svixId = verifySvixRequest({
    key,
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    body: rawBody,
    nowMs: Date.now(),
  });
  if (!svixId) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Before the marker: an event we don't handle leaves nothing behind.
  let event: { type?: unknown } | null;
  try {
    event = JSON.parse(rawBody) as { type?: unknown } | null;
  } catch {
    return NextResponse.json({ ok: true, ignored: "invalid-json" });
  }
  if (!isTrackedEmailEvent(event?.type)) {
    return NextResponse.json({ ok: true, ignored: "event-type" });
  }

  const marker = getAdminDb().collection(DELIVERIES).doc(svixId);
  try {
    await marker.create({
      receivedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + DELIVERY_MARKER_TTL_MS),
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 6) {
      // Already processed: acknowledge, or Svix retries it as a failure.
      return NextResponse.json({ ok: true, ignored: true });
    }
    console.error(
      "[webhooks/resend/events] delivery marker write failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Try again" }, { status: 500 });
  }

  try {
    await handleResendDeliveryEvent(event as ResendDeliveryEvent);
  } catch (err) {
    console.error(
      `[webhooks/resend/events] ${event.type} failed`,
      err instanceof Error ? err.message : String(err),
    );
    await marker.delete().catch((e: unknown) =>
      console.error(
        "[webhooks/resend/events] marker release failed; Resend's retry will be refused",
        svixId,
        e instanceof Error ? e.message : String(e),
      ),
    );
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

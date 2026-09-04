import { NextResponse } from "next/server";
import { verifyPaystackSignature } from "@/lib/paystack/webhook-signature";
import {
  handlePaystackEvent,
  type PaystackEvent,
} from "@/lib/paystack/webhooks";

export const dynamic = "force-dynamic";

/**
 * Client Billing's Paystack webhook. Public path — the signature IS the
 * authentication, exactly as it is for the Stripe endpoint.
 *
 * Register this URL at dashboard.paystack.com → Settings → API Keys &
 * Webhooks. Paystack signs with the account's secret key, so there is no
 * separate webhook secret to configure or rotate.
 */
export async function POST(request: Request) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secretKey) {
    // Nothing can be verified without the key, so nothing may be acted on.
    // 503 rather than 200: a silent success would let Paystack believe the
    // event was handled and stop retrying it.
    console.error("[paystack] webhook hit with no PAYSTACK_SECRET_KEY set");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  // The RAW body is what was signed — parsing first and re-serializing would
  // change the bytes and fail every signature.
  const rawBody = await request.text();
  if (
    !verifyPaystackSignature(
      rawBody,
      request.headers.get("x-paystack-signature"),
      secretKey,
    )
  ) {
    console.error("[paystack] webhook signature verification failed");
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    // Signed by us and still unparseable means Paystack sent something new.
    // 400 is honest; retrying it would not help.
    console.error("[paystack] webhook body was signed but not valid JSON");
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  if (!event?.event || typeof event.event !== "string") {
    console.error("[paystack] webhook payload had no event type");
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  try {
    await handlePaystackEvent(event);
  } catch (err) {
    // 500 so Paystack retries. Every handler is idempotent, so a retry after a
    // partial failure re-runs safely — and swallowing this would drop a
    // client's activation on a transient Firestore error.
    console.error(`[paystack] handler failed for ${event.event}`, err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

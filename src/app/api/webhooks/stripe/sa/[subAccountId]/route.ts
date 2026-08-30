import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { readStripeConnectionSecret } from "@/lib/stripe/sub-account-client";
import { reconcileStripeEvent } from "@/lib/stripe/order-reconciler";

export const dynamic = "force-dynamic";

/**
 * Per-sub-account Stripe webhook (Payments v1, Tier 1).
 *
 * NOT `/api/webhooks/stripe` — that endpoint belongs to the AGENCY's own
 * Stripe account (founders checkout, Client Billing subscriptions, LeadStack
 * dispute defense) and verifies against `STRIPE_WEBHOOK_SECRET`. This one
 * verifies against a signing secret unique to ONE sub-account's own Stripe
 * account, stored server-side at
 * `subAccounts/{id}/private/stripeConnection.webhookSecret`.
 *
 * Public path (registered in middleware's PUBLIC_PATH_PATTERNS) because the
 * caller is Stripe, not a logged-in user. **The signature IS the credential** —
 * same security model as the QStash callbacks and the calendar feed. The
 * sub-account id in the URL is untrusted routing information; it only selects
 * which secret to verify against, and a request that can't produce a valid
 * signature for that secret gets nothing.
 *
 * Always returns 200 on anything that isn't a signature failure. A non-2xx
 * makes Stripe retry — which for an already-recorded payment is pure noise,
 * and repeated failures eventually disable the endpoint on the client's own
 * account (breaking their payments, in their dashboard, which we can't fix).
 *
 * Tier 2 adds a sibling `/api/webhooks/stripe/connect` that resolves the
 * sub-account from `event.account` and calls the same reconciler.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const conn = await readStripeConnectionSecret(subAccountId);
  if (!conn || conn.mode !== "key" || !conn.webhookSecret) {
    // Disconnected (or never finished the webhook step) but Stripe is still
    // delivering. 200 so their endpoint isn't auto-disabled by retries — the
    // operator may be mid-reconnect.
    console.warn(
      `[webhooks/stripe/sa] no usable connection sa=${subAccountId} — dropping event`,
    );
    return NextResponse.json({ received: true, ignored: "not_connected" });
  }

  let event: Stripe.Event;
  try {
    // constructEvent needs a Stripe instance but only for its crypto helpers;
    // no API call is made, so an unauthenticated instance is fine here.
    event = new Stripe(conn.restrictedKey).webhooks.constructEvent(
      body,
      signature,
      conn.webhookSecret,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // The ONE case that must be non-200: an unverified body is not Stripe.
    console.error(
      `[webhooks/stripe/sa] signature verification failed sa=${subAccountId}: ${message}`,
    );
    return NextResponse.json(
      { error: `Webhook Error: ${message}` },
      { status: 400 },
    );
  }

  const result = await reconcileStripeEvent({ subAccountId, event });
  return NextResponse.json({ received: true, ...result });
}

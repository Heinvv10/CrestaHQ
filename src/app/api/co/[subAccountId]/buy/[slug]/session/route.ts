import "server-only";

import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { mapStripeSessionError } from "@/lib/stripe/session-error";
import { centsToStripeAmount, stripeCanChargeCurrency } from "@/lib/stripe/amount";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { attachCheckoutSession, createPendingOrder } from "@/lib/server/orders-service";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import {
  canBuyExpressNow,
  deliverySnapshots,
  loadBuyContext,
  mintThanksToken,
} from "@/lib/server/product-buy-service";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Express buy link: one product, straight to Stripe Checkout. Unauthenticated,
 * so price, currency and name come from Firestore only — the body carries
 * nothing that is read. Stripe collects the buyer's email and name, and the
 * webhook reconciles the contact from them once paid.
 *
 * Order of work: rate limit → re-check the product (loadBuyContext) → rail →
 * pending order → Stripe session → session id onto the order. The order is
 * written BEFORE the provider call, so no session can exist without a row.
 *
 * Paystack (ZAR-only workspaces) is unit F3 and community access unit F4:
 * until they land such a product answers 503 and no order or session is
 * created (`canBuyExpressNow`).
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const UNAVAILABLE = "This item isn't available to buy right now.";
const NOT_YET = "Buying this online isn't available yet.";
const PAYMENTS_DOWN = "Payments are temporarily unavailable. Please try again later.";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string; slug: string }> },
) {
  const { subAccountId, slug } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  // Nothing in the body is used; the cap only stops a huge upload.
  const read = await readJsonCapped(request, 4 * 1024);
  if (!read.ok && read.reason === "too_large") return fail("Request too large.", 413);

  const buy = await loadBuyContext(subAccountId, slug);
  if (!buy) return fail(UNAVAILABLE, 404);
  // A linked checkout page owns this product's sale (bumps, extra fields).
  if (buy.checkoutPageSlug) return fail(UNAVAILABLE, 409);
  if (!canBuyExpressNow(buy)) return fail(NOT_YET, 503);
  const { product, agencyId } = buy;

  const currency = product.currency.toLowerCase();
  if (!stripeCanChargeCurrency(currency)) return fail(UNAVAILABLE, 404);

  try {
    await getSubAccountStripe(subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(`[buy/session] connection unusable sa=${subAccountId} code=${err.code}`);
      return fail(PAYMENTS_DOWN, 503);
    }
    throw err;
  }

  const lineItems: OrderLineItem[] = [
    {
      productId: product.id,
      name: product.name,
      description: product.description ?? "",
      unitPriceCents: product.unitPriceCents,
      quantity: 1,
      isBump: false,
    },
  ];
  const thanks = mintThanksToken();

  let orderId: string;
  try {
    orderId = await createPendingOrder({
      agencyId,
      subAccountId,
      contactId: null,
      checkoutPageId: null,
      source: "product_link",
      currency,
      lineItems,
      // Set by attachCheckoutSession once Stripe returns the session.
      stripeCheckoutSessionId: "",
      livemode: false,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
      productLinkProductId: product.id,
      deliveries: deliverySnapshots([product]),
      thanksTokenHash: thanks.hash,
    });
  } catch (err) {
    // An unrecorded payment is worse than a failed checkout, so refuse.
    console.error(
      `[buy/session] pending order write failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fail(PAYMENTS_DOWN, 500);
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const buyPath = `${base}/co/${subAccountId}/buy/${slug}`;
  const description = (product.publicDescription || product.description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const promise =
    product.delivery?.type === "download"
      ? "Your download link appears right after payment."
      : null;

  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId,
      params: {
        mode: "payment",
        line_items: lineItems.map((li) => ({
          quantity: li.quantity,
          price_data: {
            currency,
            unit_amount: centsToStripeAmount(li.unitPriceCents, currency),
            product_data: {
              name: li.name,
              ...(description ? { description } : {}),
            },
          },
        })),
        submit_type: "pay",
        locale: "auto",
        name_collection: { individual: { enabled: true } },
        ...(promise ? { custom_text: { submit: { message: promise } } } : {}),
        success_url: `${buyPath}/thanks?order=${orderId}&t=${thanks.token}`,
        cancel_url: `${buyPath}?cancelled=1`,
        metadata: {
          leadstackSubAccountId: subAccountId,
          leadstackProductId: product.id,
          leadstackOrderId: orderId,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(`[buy/session] stripe session failed sa=${subAccountId} — ${mapped.logDetail}`);
    await markUnpayable(orderId);
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) {
    await markUnpayable(orderId);
    return fail(PAYMENTS_DOWN, 502);
  }

  // The buyer gets the URL only after the order knows its session, so the
  // webhook can always match the payment to it.
  try {
    if (!(await attachCheckoutSession(orderId, { id: session.id, livemode: session.livemode }))) {
      throw new Error("order no longer pending");
    }
  } catch (err) {
    console.error(
      `[buy/session] attach session failed sa=${subAccountId} order=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fail(PAYMENTS_DOWN, 500);
  }

  return NextResponse.json({ url: session.url });
}

/** The session never opened, so the order can never be paid: close it. */
async function markUnpayable(orderId: string): Promise<void> {
  try {
    await attachCheckoutSession(orderId, null);
  } catch (err) {
    // It stays pending with no session: unpayable, just untidy.
    console.error(
      `[buy/session] could not close order=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

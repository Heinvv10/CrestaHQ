import "server-only";

import { NextResponse } from "next/server";

import { stripeCanChargeCurrency } from "@/lib/stripe/amount";
import { getSubAccountStripe, StripeConnectionError } from "@/lib/stripe/sub-account-client";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import { canBuyExpressNow, loadBuyContext } from "@/lib/server/product-buy-service";
import {
  buyerKey,
  dedupedSession,
  openProductLinkSession,
  PAYMENTS_DOWN,
} from "@/lib/server/product-buy-session";
import { readJsonCapped } from "@/lib/server/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * Express buy link: one product, straight to Stripe Checkout. Unauthenticated,
 * so price, currency and name come from Firestore only — the body carries
 * nothing that is read. Stripe collects the buyer's email and name, and the
 * webhook reconciles the contact from them once paid.
 *
 * Order of work: rate limit → re-check the product (loadBuyContext) → rail →
 * Stripe connection → (dedupe a double click) → pending order → Stripe
 * session → session id onto the order (product-buy-session.ts).
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

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string; slug: string }> },
) {
  const { subAccountId, slug } = await ctx.params;

  const ip = clientIpFrom(request);
  const rate = checkCheckoutRateLimit(ip);
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
  const { product } = buy;

  if (!stripeCanChargeCurrency(product.currency)) return fail(UNAVAILABLE, 404);

  try {
    await getSubAccountStripe(subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(`[buy/session] connection unusable sa=${subAccountId} code=${err.code}`);
      return fail(PAYMENTS_DOWN, 503);
    }
    throw err;
  }

  const result = await dedupedSession(buyerKey(subAccountId, product.id, ip), () =>
    openProductLinkSession(buy, subAccountId, slug),
  );
  return result.ok ? NextResponse.json({ url: result.url }) : fail(result.error, result.status);
}

import "server-only";

import { NextResponse } from "next/server";

import { stripeCanChargeCurrency } from "@/lib/stripe/amount";
import { getSubAccountStripe, StripeConnectionError } from "@/lib/stripe/sub-account-client";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import { loadBuyContext } from "@/lib/server/product-buy-service";
import {
  buyRequestKey,
  dedupedSession,
  isBuyRequestId,
  openProductLinkSession,
  PAYMENTS_DOWN,
} from "@/lib/server/product-buy-session";
import { openProductPaystackSession } from "@/lib/server/product-buy-paystack";
import { readJsonCapped } from "@/lib/server/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * Express buy link: one product, straight to Stripe Checkout. Unauthenticated,
 * so price, currency and name come from Firestore only — the body carries
 * only the buy button's request id (and, on Paystack, the buyer's email).
 * Stripe collects the buyer's email and name, and the webhook reconciles the
 * contact from them once paid.
 *
 * Order of work: rate limit → re-check the product (loadBuyContext) → rail →
 * Stripe connection → (dedupe a double click) → pending order → Stripe
 * session → session id onto the order (product-buy-session.ts).
 *
 * The Paystack rail (ZAR-only workspaces) differs only in that Paystack's
 * page cannot ask for the buyer's email, so the body also carries `email`;
 * the order and the payment attempt are written before Paystack is called
 * (product-buy-paystack.ts).
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const UNAVAILABLE = "This item isn't available to buy right now.";
// No whitespace or address-list/quoting characters: the address goes into
// Paystack's request and our mail header as the one recipient.
const EMAIL_RE = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
// NUL, other control and invisible format characters (zero-width, bidi
// overrides): \s misses them, and none belongs in a real address.
const HIDDEN_CHAR = /[\p{Cc}\p{Cf}]/u;

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

  // The only field read is the buy button's per-page-load request id (for
  // the double-click dedupe); nothing about money comes from the body.
  const read = await readJsonCapped(request, 4 * 1024);
  if (!read.ok && read.reason === "too_large") return fail("Request too large.", 413);
  const body = read.ok && read.value && typeof read.value === "object" ? (read.value as Record<string, unknown>) : {};
  const requestId = body.requestId;
  if (requestId !== undefined && !isBuyRequestId(requestId)) return fail("Invalid request.", 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const buy = await loadBuyContext(subAccountId, slug);
  if (!buy) return fail(UNAVAILABLE, 404);
  // A linked checkout page owns this product's sale (bumps, extra fields).
  if (buy.checkoutPageSlug) return fail(UNAVAILABLE, 409);
  const { product } = buy;

  if (buy.rail === "paystack") {
    // Paystack's hosted page shows the email, it does not ask for it.
    if (!EMAIL_RE.test(email) || HIDDEN_CHAR.test(email) || email.length > 254) return fail("Enter a valid email address.", 400);
    const paystack = await dedupedSession(
      requestId ? buyRequestKey(subAccountId, product.id, requestId, email) : null,
      { unitPriceCents: product.unitPriceCents, currency: product.currency },
      () => openProductPaystackSession(buy, subAccountId, slug, email),
    );
    return paystack.ok ? NextResponse.json({ url: paystack.url }) : fail(paystack.error, paystack.status);
  }

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

  const result = await dedupedSession(
    requestId ? buyRequestKey(subAccountId, product.id, requestId) : null,
    { unitPriceCents: product.unitPriceCents, currency: product.currency },
    () => openProductLinkSession(buy, subAccountId, slug),
  );
  return result.ok ? NextResponse.json({ url: result.url }) : fail(result.error, result.status);
}

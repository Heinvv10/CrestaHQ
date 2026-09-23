import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQuoteToken } from "@/lib/quotes/token";
import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import { mapStripeSessionError } from "@/lib/stripe/session-error";
import { stripeCanChargeCurrency, toStripeAmount } from "@/lib/stripe/amount";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import type { Quote } from "@/types/quotes";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Public "Pay by card" for an INVOICE — Payments v1, Phase B.
 *
 * The recipient's HMAC token IS the credential (same model as accept/decline
 * at `/api/quotes/[token]/respond`): verify the signature, then re-hash the
 * presented token and compare against the stored `publicTokenHash`, so a
 * re-sent invoice invalidates older links.
 *
 * Money never comes from the request — there is no body at all. The amount is
 * recomputed from the invoice's own line items via `computeQuoteTotals()`, the
 * same pure function the recipient's page and the PDF use, so what the buyer
 * was shown is what Stripe charges.
 *
 * On payment, the webhook reconciler marks BOTH the order and the invoice paid
 * through `markQuotePaidServerSide()` — the same path the operator's manual
 * "Mark as paid" button uses. There is no second paid-path.
 *
 * PayPal is untouched: an invoice with no Stripe connection still renders its
 * paypal.me link exactly as before.
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  const verified = verifyQuoteToken(token);
  // 404 on a bad token — never confirm whether the invoice exists.
  if (!verified) return fail("This payment link isn't valid.", 404);

  const db = getAdminDb();
  const quoteRef = db.doc(`quotes/${verified.quoteId}`);
  const snap = await quoteRef.get();
  if (!snap.exists) return fail("This payment link isn't valid.", 404);

  const quote = { id: snap.id, ...(snap.data() as Omit<Quote, "id">) };
  if (quote.publicTokenHash !== verified.hash) {
    return fail(
      "A newer version of this invoice has been sent. Please use the most recent email.",
      404,
    );
  }
  if (quote.kind !== "invoice") {
    return fail("Only invoices can be paid online.", 409);
  }
  if (quote.status === "paid") {
    return fail("This invoice has already been paid.", 409);
  }
  if (effectiveQuoteStatus(quote) === "expired") {
    return fail("This invoice has expired. Please ask for a new one.", 409);
  }
  if (quote.status !== "sent" && quote.status !== "viewed") {
    return fail("This invoice isn't ready for payment.", 409);
  }

  // Gate — the agency may have switched Payments off since the invoice went out.
  const subSnap = await db.doc(`subAccounts/${quote.subAccountId}`).get();
  if (subSnap.data()?.paymentsEnabledByAgency !== true) {
    return fail("Card payment isn't available for this invoice.", 409);
  }

  const totals = computeQuoteTotals(quote);
  if (totals.total <= 0) {
    return fail("This invoice has nothing to pay.", 409);
  }

  const currency = (quote.currency || "USD").toLowerCase();
  if (!stripeCanChargeCurrency(currency)) {
    return fail(`Card payment isn't available in ${currency.toUpperCase()}.`, 409);
  }
  // Quote line items are in WHOLE units (legacy schema); orders are in cents.
  // Stripe's own amount differs for zero-decimal currencies (toStripeAmount).
  const totalCents = Math.round(totals.total * 100);
  const lineItems: OrderLineItem[] = [
    {
      productId: null,
      name: `Invoice ${quote.quoteNumber}`,
      description: "",
      unitPriceCents: totalCents,
      quantity: 1,
      isBump: false,
    },
  ];

  // Pre-flight: fail fast with a SPECIFIC message when the workspace isn't
  // connected, or its webhook isn't finished, rather than letting the session
  // call fail with a generic one. The session itself is created below via
  // createCheckoutSessionForSubAccount().
  try {
    await getSubAccountStripe(quote.subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(
        `[quotes/pay] connection unusable sa=${quote.subAccountId} code=${err.code}`,
      );
      return fail(
        "Card payment is temporarily unavailable. Please use the other payment option or contact the sender.",
        503,
      );
    }
    throw err;
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: quote.subAccountId,
      params: {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: toStripeAmount(totals.total, currency),
              product_data: { name: `Invoice ${quote.quoteNumber}` },
            },
          },
        ],
        success_url: `${base}/q/${token}?paid=1`,
        cancel_url: `${base}/q/${token}?cancelled=1`,
        metadata: {
          leadstackSubAccountId: quote.subAccountId,
          leadstackQuoteId: quote.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[quotes/pay] stripe session failed quote=${quote.id} — ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) return fail("Card payment is temporarily unavailable.", 502);

  try {
    await createPendingOrder({
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      contactId: quote.contactId,
      checkoutPageId: null,
      quoteId: quote.id,
      source: "quote",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
    });
  } catch (err) {
    // Without an order row the webhook can't mark the invoice paid, so refuse
    // rather than take a payment we'd only discover in the Stripe dashboard.
    console.error(`[quotes/pay] pending order write failed quote=${quote.id}`, err);
    return fail("Card payment is temporarily unavailable.", 500);
  }

  return NextResponse.json({ url: session.url });
}

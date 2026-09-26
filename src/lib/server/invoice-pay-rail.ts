import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { buildPaypalInvoiceUrl } from "@/lib/paypal/payment-link";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { cardChargeUnsettled } from "@/lib/quotes/calc";
import { createPaymentLink } from "@/lib/server/payment-links-service";
import { loadActiveSchedule } from "@/lib/server/payment-mandates";
import { PAYMENT_LINK_CURRENCY } from "@/types/payment-links";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types";

/**
 * How an invoice being sent can be paid — step 5a of `sendQuoteServerSide`.
 * An invoice is never emailed with no way to pay it. In order:
 *
 *   a. from an active card-mode recurring schedule → a
 *      card-on-file link: paying it settles this invoice and saves the card.
 *      If it can't be made — or Paystack isn't ready — the reason is returned
 *      (`cardLinkFallback`) and the send falls through to the next rail;
 *   b. PayPal configured → a paypal.me URL, rebuilt on every send;
 *   c. Stripe ready → nothing to mint: /q/[token] renders the card button;
 *   d. Paystack ready → a plain Paystack payment link;
 *   e. none → `no_payment_rail`.
 *
 * Existing PayPal and Stripe tenants are therefore untouched by Paystack,
 * except for a card-mode schedule's invoice. An invoice with a recurring card
 * charge that wasn't declined (pending, unconfirmed, paid, needs attention)
 * gets no way to pay at all: that could charge the customer twice.
 *
 * "Paystack ready" = Payments enabled by the agency, a Paystack connection,
 * and a ZAR invoice. A Paystack link is minted while the invoice may still be
 * a draft; `loadPayableLink` refuses to take payment until it is sent, so a
 * link left behind by a send that then fails cannot be paid. A re-send hands
 * back the same open link (`createPaymentLink` reuses it).
 */

export type PaymentLinkUpdate = {
  paymentLinkUrl: string;
  paymentLinkId: string | null;
  paymentLinkMintedAt: ReturnType<typeof FieldValue.serverTimestamp>;
};

/** Which way the invoice is paid: a Paystack card-on-file link, a plain
 *  Paystack link, a paypal.me URL, or Stripe's card button on /q/[token]. */
export type PayRailKind = "paystack_card" | "paystack" | "paypal" | "stripe";

export type InvoicePayRail =
  | {
      ok: true;
      rail: PayRailKind;
      /** Written onto the invoice with the send; null = nothing minted. */
      update: PaymentLinkUpdate | null;
      /** A Paystack pay URL to put in the email itself; null otherwise. */
      emailPayUrl: string | null;
      /** Why the card-on-file link wasn't made, and which rail was used instead. */
      cardLinkFallback: string | null;
    }
  | { ok: false; code: string; status: number; error: string };

const stripeIsReady = (sub: SubAccountDoc | null) =>
  sub?.paymentsEnabledByAgency === true && sub?.stripeConnectionMeta?.ready === true;

/** Why Paystack can't take this invoice, or null when it can. */
async function paystackBlockerFor(quote: Quote, sub: SubAccountDoc | null): Promise<string | null> {
  return sub?.paymentsEnabledByAgency !== true
    ? "Payments is off for this workspace"
    : (quote.currency || "").toUpperCase() !== PAYMENT_LINK_CURRENCY
      ? "the invoice is not in ZAR"
      : (await readPaystackConnectionSecret(quote.subAccountId)) === null
        ? "Paystack is not connected"
        : null;
}

/** A card-mode schedule's invoice asks for a card-on-file link first (a pro-rata
 *  is deliberately not the authorised amount: no link, and nothing to "fix"). */
async function wantsCardLink(quote: Quote): Promise<boolean> {
  const schedule = await loadActiveSchedule(quote.subAccountId, quote.recurringInvoiceId);
  return schedule?.chargeMode === "card" && !quote.prorated;
}

/**
 * The rail `chooseInvoicePayRail` would pick if every link it makes can be
 * made, without making one (an approver's preview). The send re-checks the
 * rail it actually used.
 */
export async function predictInvoicePayRail(
  quote: Quote,
  sub: SubAccountDoc | null,
): Promise<{ ok: true; rail: PayRailKind } | { ok: false; error: string }> {
  if (cardChargeUnsettled(quote)) return { ok: false, error: UNSETTLED[quote.autoCharge!.state] };
  const paystackReady = (await paystackBlockerFor(quote, sub)) === null;
  if ((await wantsCardLink(quote)) && paystackReady) return { ok: true, rail: "paystack_card" };
  if (sub?.paypalConfig?.username) return { ok: true, rail: "paypal" };
  if (stripeIsReady(sub)) return { ok: true, rail: "stripe" };
  if (paystackReady) return { ok: true, rail: "paystack" };
  return { ok: false, error: NO_RAIL };
}

export async function chooseInvoicePayRail(quote: Quote, sub: SubAccountDoc | null): Promise<InvoicePayRail> {
  if (cardChargeUnsettled(quote)) return fail("card_charge_unsettled", 409, UNSETTLED[quote.autoCharge!.state]);
  const paypal = sub?.paypalConfig ?? null;
  const stripeReady = stripeIsReady(sub);
  const paystackBlocker = await paystackBlockerFor(quote, sub);
  const paystackReady = paystackBlocker === null;

  let cardLinkError: string | null = null;
  if (await wantsCardLink(quote)) {
    const mandate = paystackReady ? await paystackLink(quote, true) : null;
    if (mandate?.ok) return mandate;
    cardLinkError = mandate ? mandate.error : paystackBlocker;
  }
  const fellBack = (rail: Extract<InvoicePayRail, { ok: true }>, name: string): InvoicePayRail => ({
    ...rail,
    cardLinkFallback: cardLinkError
      ? `Card-on-file link could not be made for invoice ${quote.quoteNumber}: ${cardLinkError} — ${name} was used instead.`
      : null,
  });

  if (paypal?.username) {
    try {
      const url = buildPaypalInvoiceUrl({ paypal, invoice: quote });
      return fellBack(
        { ok: true, rail: "paypal", update: minted(url, null), emailPayUrl: null, cardLinkFallback: null },
        "a PayPal link",
      );
    } catch (err) {
      console.error("[quotes/send] paypal link build failed", err);
      return fail(
        "paypal_link_failed",
        500,
        `Failed to build PayPal link: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }
  if (stripeReady) {
    return fellBack({ ok: true, rail: "stripe", update: null, emailPayUrl: null, cardLinkFallback: null }, "Stripe card payment");
  }
  if (paystackReady) {
    const plain = await paystackLink(quote, false);
    return plain.ok ? fellBack(plain, "a Paystack payment link") : plain;
  }
  return fail("no_payment_rail", 503, NO_RAIL);
}

const NO_RAIL = "Connect Paystack, Stripe or PayPal under Settings → Payments before sending invoices.";

/** Why an invoice with a live card charge gets no way to pay, by the charge's state. */
const UNSETTLED: Record<string, string> = {
  pending:
    'This invoice\'s card charge is still being confirmed. Use "Re-check card charge" to ask Paystack, instead of sending a pay link.',
  unknown:
    'This invoice\'s card charge has no clear outcome yet. Use "Re-check card charge" to ask Paystack, instead of sending a pay link.',
  paid: "This invoice was already paid by its saved card. There is nothing to send a pay link for.",
  needs_attention:
    "The saved card was charged for this invoice, but the payment needs attention: see its Task and your Paystack dashboard. Don't send a pay link — it would charge the customer twice.",
};

const fail = (code: string, status: number, error: string) => ({ ok: false as const, code, status, error });

const minted = (url: string, id: string | null): PaymentLinkUpdate => ({
  paymentLinkUrl: url,
  paymentLinkId: id,
  paymentLinkMintedAt: FieldValue.serverTimestamp(),
});

async function paystackLink(quote: Quote, mandate: boolean): Promise<InvoicePayRail> {
  const link = await createPaymentLink({
    subAccountId: quote.subAccountId,
    uid: quote.createdByUid,
    invoiceId: quote.id,
    mandate,
    allowDraftForSend: true,
  });
  if (!link.ok) {
    return fail("paystack_link_failed", link.status, link.error);
  }
  // Same base as the Paystack checkout's callback URL.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const url = `${base}/pay/link/${link.link.token}`;
  return { ok: true, rail: mandate ? "paystack_card" : "paystack", update: minted(url, link.link.id), emailPayUrl: url, cardLinkFallback: null };
}

import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { buildPaypalInvoiceUrl } from "@/lib/paypal/payment-link";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { createPaymentLink } from "@/lib/server/payment-links-service";
import { loadActiveSchedule } from "@/lib/server/payment-mandates";
import { PAYMENT_LINK_CURRENCY } from "@/types/payment-links";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types";

/**
 * How an invoice being sent can be paid — step 5a of `sendQuoteServerSide`.
 * An invoice is never emailed with no way to pay it. In order:
 *
 *   a. from an active card-mode recurring schedule, Paystack ready → a
 *      card-on-file link: paying it settles this invoice and saves the card;
 *   b. PayPal configured → a paypal.me URL, rebuilt on every send;
 *   c. Paystack ready → a plain Paystack payment link;
 *   d. Stripe ready → nothing to mint: /q/[token] renders the card button;
 *   e. none → `no_payment_rail`.
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

export type InvoicePayRail =
  | {
      ok: true;
      /** Written onto the invoice with the send; null = nothing minted. */
      update: PaymentLinkUpdate | null;
      /** A Paystack pay URL to put in the email itself; null otherwise. */
      emailPayUrl: string | null;
    }
  | { ok: false; code: string; status: number; error: string };

export async function chooseInvoicePayRail(quote: Quote, sub: SubAccountDoc | null): Promise<InvoicePayRail> {
  const paypal = sub?.paypalConfig ?? null;
  const stripeReady = sub?.paymentsEnabledByAgency === true && sub?.stripeConnectionMeta?.ready === true;
  const paystackReady =
    sub?.paymentsEnabledByAgency === true &&
    (quote.currency || "").toUpperCase() === PAYMENT_LINK_CURRENCY &&
    (await readPaystackConnectionSecret(quote.subAccountId)) !== null;

  if (paystackReady) {
    const schedule = await loadActiveSchedule(quote.subAccountId, quote.recurringInvoiceId);
    if (schedule?.chargeMode === "card") return paystackLink(quote, true);
  }
  if (paypal?.username) {
    try {
      const url = buildPaypalInvoiceUrl({ paypal, invoice: quote });
      return {
        ok: true,
        update: { paymentLinkUrl: url, paymentLinkId: null, paymentLinkMintedAt: FieldValue.serverTimestamp() },
        emailPayUrl: null,
      };
    } catch (err) {
      console.error("[quotes/send] paypal link build failed", err);
      return {
        ok: false,
        code: "paypal_link_failed",
        status: 500,
        error: `Failed to build PayPal link: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  }
  if (paystackReady) return paystackLink(quote, false);
  if (stripeReady) return { ok: true, update: null, emailPayUrl: null };
  return {
    ok: false,
    code: "no_payment_rail",
    status: 503,
    error: "Connect Paystack, Stripe or PayPal under Settings → Payments before sending invoices.",
  };
}

async function paystackLink(quote: Quote, mandate: boolean): Promise<InvoicePayRail> {
  const minted = await createPaymentLink({
    subAccountId: quote.subAccountId,
    uid: quote.createdByUid,
    invoiceId: quote.id,
    mandate,
    allowDraftForSend: true,
  });
  if (!minted.ok) {
    return { ok: false, code: "paystack_link_failed", status: minted.status, error: minted.error };
  }
  // Same base as the Paystack checkout's callback URL.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const url = `${base}/pay/link/${minted.link.token}`;
  return {
    ok: true,
    update: { paymentLinkUrl: url, paymentLinkId: minted.link.id, paymentLinkMintedAt: FieldValue.serverTimestamp() },
    emailPayUrl: url,
  };
}

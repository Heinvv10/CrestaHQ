import { randomBytes } from "node:crypto";

import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import type { Quote } from "@/types/quotes";

/** Pure payment-link rules shared by the service and the reconciler. */

/** Invoice totals are stored in whole units; links are in cents. */
export function invoiceTotalCents(quote: Quote): number {
  return Math.round(computeQuoteTotals(quote).total * 100);
}

/** Same rule as the Stripe invoice pay route: sent or viewed, not expired. */
export function invoicePayable(quote: Quote): boolean {
  return (
    quote.kind === "invoice" &&
    (quote.status === "sent" || quote.status === "viewed") &&
    effectiveQuoteStatus(quote) !== "expired"
  );
}

/**
 * `pl-{linkId}-{nonce}`. A fresh reference per checkout, because Paystack
 * refuses a reference it has already seen and a customer may open the link
 * twice. The link id inside it is how the reconciler finds the doc.
 */
export function paymentLinkReference(linkId: string): string {
  return `pl-${linkId}-${randomBytes(8).toString("hex")}`;
}

export function parsePaymentLinkReference(reference: string): string | null {
  return /^pl-([A-Za-z0-9]+)-[0-9a-f]{16}$/.exec(reference)?.[1] ?? null;
}

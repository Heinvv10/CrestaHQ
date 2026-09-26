import "server-only";

import { renderQuoteEmail, type RenderQuoteEmailInput, type RenderedQuoteEmail } from "@/lib/quotes/email";
import { predictInvoicePayRail, type PayRailKind } from "@/lib/server/invoice-pay-rail";
import type { SubAccountDoc } from "@/types";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import type { Quote } from "@/types/quotes";

/**
 * What an approver reviews for an agent's send_quote, and what the send
 * checks against (`sendQuoteServerSide`'s `expect`). The quote's link and a
 * Paystack pay link are made at send time, so both the preview and the check
 * render the email with these placeholders in their place; every other
 * character is the email that goes out.
 */

export const QUOTE_LINK_SHOWN = "[the quote's own link, made when it is sent]";
export const PAY_LINK_SHOWN = "[a Paystack payment link, made when it is sent]";

export interface QuoteSendExpect {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Invoices: how it is paid; null for a quote. */
  rail: PayRailKind | null;
  /** quoteFingerprint of the reviewed document. */
  fingerprint: string;
}

/** Everything on the document the customer opens: the email shows the
 *  total, the linked page shows the rest. */
export function quoteFingerprint(q: Quote): string {
  const at = (v: unknown) => (v && typeof (v as { toMillis?: unknown }).toMillis === "function" ? (v as { toMillis: () => number }).toMillis() : null);
  return canonical([
    q.kind, q.quoteNumber, q.contactId, q.currency, q.lineItems, q.globalDiscount ?? null, q.globalTaxPercent ?? null,
    q.termsAndNotes ?? "", q.billedToOrganization ?? null, q.billingAddress ?? null, at(q.validUntil), q.paymentDueDays ?? null,
  ]);
}

/** The email with the placeholders where the send's fresh links go. */
export function emailAsReviewed(
  input: Omit<RenderQuoteEmailInput, "publicUrl" | "payUrl"> & { payLink: boolean },
): RenderedQuoteEmail {
  const { payLink, ...rest } = input;
  return renderQuoteEmail({ ...rest, publicUrl: QUOTE_LINK_SHOWN, payUrl: payLink ? PAY_LINK_SHOWN : null });
}

type Reviewed = Omit<RenderQuoteEmailInput, "publicUrl" | "payUrl">;
const payLinkOn = (rail: PayRailKind | null) => rail === "paystack" || rail === "paystack_card";

/** Does the email, sent with this rail, differ from what was approved? */
export function differsFromReviewed(e: QuoteSendExpect, input: Reviewed, rail: PayRailKind | null, payLink = payLinkOn(rail)): boolean {
  const shown = emailAsReviewed({ ...input, payLink });
  return rail !== e.rail || shown.subject !== e.subject || shown.text !== e.text || shown.html !== e.html;
}

/** The same, with the rail the send would pick, before it mints a link. */
export async function differsBeforeRail(e: QuoteSendExpect, input: Reviewed, sub: SubAccountDoc | null): Promise<boolean> {
  if (input.quote.kind !== "invoice") return differsFromReviewed(e, input, null);
  const predicted = await predictInvoicePayRail(input.quote, sub);
  return !predicted.ok || differsFromReviewed(e, input, predicted.rail);
}

import "server-only";

import { verifyPaymentLinkToken } from "@/lib/billing/token";
import { getAdminDb } from "@/lib/firebase/admin";
import { paystackKeyMode } from "@/lib/paystack/key-fingerprint";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { loadActiveSchedule, termsStillHold } from "@/lib/server/payment-mandates";
import { effectiveQuoteStatus } from "@/lib/quotes/calc";
import type { PaymentMode } from "@/types/payment-attempts";
import type { PaymentLink } from "@/types/payment-links";
import type { Quote } from "@/types/quotes";

import { loadPaymentAttempt } from "./payment-attempts";
import { fail, invoicePayable, invoiceTotalCents, parsePaymentLinkReference, type ServiceResult } from "./payment-link-rules";

/**
 * The link behind a public token, or why it can't be paid. Shared by the pay
 * page's GET (show it) and POST (start checkout) so both refuse the same links.
 */
export async function loadPayableLink(
  token: string,
  opts: { reference?: string | null } = {},
): Promise<ServiceResult<{ link: PaymentLink; mode: PaymentMode | null }>> {
  const linkId = verifyPaymentLinkToken(token);
  if (!linkId) return fail(404, "The link may be incomplete. Ask for a fresh payment link.");
  const snap = await getAdminDb().doc(`paymentLinks/${linkId}`).get();
  const data = snap.data() as Omit<PaymentLink, "id"> | undefined;
  if (!data || data.token !== token) {
    return fail(404, "The link may be incomplete. Ask for a fresh payment link.");
  }
  const link = { id: linkId, ...data };
  const reference = opts.reference ?? null;
  // A payer back from Paystack is never shown a dead link (it could prompt a
  // second payment) once the link is paid, or the reference is one of THIS
  // link's checkouts — withdrawn or Payments-off mid-checkout. Junk gets neither.
  if (reference !== null && (link.status === "paid" || (await isOwnCheckout(reference, link.id)))) {
    return { ok: true, link, mode: null };
  }
  if (link.status === "paid") return fail(410, "This has already been paid — nothing more to pay.");
  if (!link.active) return fail(410, "This payment link has been withdrawn. Contact the sender if you think that's a mistake.");
  // Re-checked at pay time, like the Stripe invoice pay route: the agency may
  // have switched Payments off since the link went out. The webhook does NOT
  // check this — a payment already taken is recorded regardless.
  const sub = (await getAdminDb().doc(`subAccounts/${link.subAccountId}`).get()).data();
  if (sub?.paymentsEnabledByAgency !== true) {
    return fail(409, "Online payment isn't available for this link. Please contact the sender.");
  }
  // Still open: a returning payer is told their payment is being confirmed,
  // never that the invoice changed or was paid (possibly by them).
  if (reference !== null) return { ok: true, link, mode: null };

  if (link.invoiceId) {
    // The link's amount was fixed when it was made. An invoice edited since,
    // or paid another way, must not be charged the stale figure.
    const quote = (await getAdminDb().doc(`quotes/${link.invoiceId}`).get()).data() as Quote | undefined;
    if (quote?.status === "paid") return fail(410, "This invoice has already been paid — nothing more to pay.");
    if (quote && effectiveQuoteStatus(quote) === "expired") {
      return fail(410, "This invoice has expired. Ask the sender for a new one.");
    }
    if (!quote || !invoicePayable(quote) || invoiceTotalCents(quote) !== link.amountCents) {
      return fail(410, "This invoice has changed since the link was sent. Ask the sender for a new payment link.");
    }
  }
  // A card-on-file link's terms were fixed when it was made. A schedule since
  // paused, re-priced or re-timed would make them false.
  if (link.mandate && !termsStillHold(link.mandate, await loadActiveSchedule(link.subAccountId, link.recurringInvoiceId))) {
    return fail(410, "The terms of this card link have changed. Ask the sender for a fresh link.");
  }
  const conn = await readPaystackConnectionSecret(link.subAccountId);
  if (!conn) return fail(503, "Online payment is unavailable right now. Please contact the sender.");
  // A link is paid in the mode it was issued in. Switching the workspace
  // between test and live retires open links rather than silently changing
  // what they charge — so the banner the payer sees, the key checkout uses,
  // and the attempt the webhook checks all agree. (A link with no `mode`
  // predates the rule and is retired too.)
  const mode = paystackKeyMode(conn.secretKey);
  if (link.mode !== mode) return fail(410, RETIRED);
  return { ok: true, link, mode };
}

/** A checkout attempt was recorded for this reference, on this link. */
const isOwnCheckout = async (reference: string, linkId: string) =>
  parsePaymentLinkReference(reference) === linkId && (await loadPaymentAttempt(reference))?.paymentLinkId === linkId;

export const RETIRED = "This payment link is no longer valid. Ask the sender for a fresh payment link.";

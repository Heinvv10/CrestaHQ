import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { issuePaymentLinkToken, verifyPaymentLinkToken } from "@/lib/billing/token";
import { getAdminDb } from "@/lib/firebase/admin";
import { initializePaystackTransaction } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint, paystackKeyMode } from "@/lib/paystack/key-fingerprint";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { loadActiveSchedule, mandateTerms, termsStillHold } from "@/lib/server/payment-mandates";
import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import type { PaymentAttempt, PaymentMode } from "@/types/payment-attempts";
import { PAYMENT_LINK_CURRENCY, type PaymentLink } from "@/types/payment-links";
import type { MandateTerms } from "@/types/payment-mandates";
import type { Quote } from "@/types/quotes";

/**
 * Paystack payment links: create, deactivate, and open a checkout.
 *
 * Nothing here marks a link paid. That happens only in
 * `lib/paystack/payment-link-reconciler.ts`, from a verified webhook.
 */

export type ServiceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/** R1,000,000. A typo guard, not a business rule. */
const MAX_AMOUNT_CENTS = 100_000_000;
const MAX_DESCRIPTION = 200;

/** Invoice totals are stored in whole units; links are in cents. */
export function invoiceTotalCents(quote: Quote): number {
  return Math.round(computeQuoteTotals(quote).total * 100);
}

/** Same rule as the Stripe invoice pay route: sent or viewed, not expired. */
function invoicePayable(quote: Quote): boolean {
  return (
    quote.kind === "invoice" &&
    (quote.status === "sent" || quote.status === "viewed") &&
    effectiveQuoteStatus(quote) !== "expired"
  );
}

export async function createPaymentLink(input: {
  subAccountId: string;
  uid: string;
  invoiceId?: string;
  amountCents?: unknown;
  description?: unknown;
  /** A card-on-file link: pays this cycle's invoice and saves the card. */
  mandate?: boolean;
  /** Invoice send only (`invoice-pay-rail.ts`): the link is minted just before a draft becomes sent. Never set from a route. */
  allowDraftForSend?: boolean;
}): Promise<ServiceResult<{ link: PaymentLink }>> {
  const db = getAdminDb();
  const sub = (await db.doc(`subAccounts/${input.subAccountId}`).get()).data();
  if (!sub) return fail(404, "Sub-account not found");
  if (sub.paymentsEnabledByAgency !== true) {
    return fail(403, "Payments isn't enabled for this workspace. Ask your agency to turn it on.");
  }
  const conn = await readPaystackConnectionSecret(input.subAccountId);
  if (!conn) {
    return fail(409, "Connect Paystack under Settings → Payments first.");
  }
  const mode = paystackKeyMode(conn.secretKey);

  let invoiceId: string | null = null;
  let contactId: string | null = null;
  let description: string;
  let amountCents: number;
  let mandate: MandateTerms | null = null;
  let recurringInvoiceId: string | null = null;
  if (input.mandate && !input.invoiceId) {
    return fail(400, "A card-on-file link is made from a recurring invoice.");
  }

  if (input.invoiceId) {
    const snap = await db.doc(`quotes/${input.invoiceId}`).get();
    const quote = snap.data() as Quote | undefined;
    if (!quote || quote.subAccountId !== input.subAccountId) {
      return fail(404, "Invoice not found");
    }
    const sendingDraft = input.allowDraftForSend === true && quote.kind === "invoice" && quote.status === "draft";
    if (!invoicePayable(quote) && !sendingDraft) {
      return fail(409, "Only a sent, unpaid, unexpired invoice can get a payment link.");
    }
    if ((quote.currency || "").toUpperCase() !== PAYMENT_LINK_CURRENCY) {
      return fail(409, "Paystack payment links are ZAR only. This invoice is in another currency.");
    }
    amountCents = invoiceTotalCents(quote);
    if (amountCents <= 0) return fail(409, "This invoice has nothing to pay.");
    if (input.mandate) {
      // The terms are fixed now, from the schedule, and shown verbatim on the
      // pay page. They must describe this invoice's amount too.
      const schedule = await loadActiveSchedule(input.subAccountId, quote.recurringInvoiceId);
      if (!schedule) return fail(409, "A card-on-file link needs an invoice from an active recurring schedule.");
      // The customer authorises a named business, never "the sender".
      if (typeof sub.name !== "string" || !sub.name.trim()) {
        return fail(409, "Set this workspace's business name first: the customer authorises it by name.");
      }
      mandate = mandateTerms(sub.name.trim(), schedule);
      if (mandate.currency !== PAYMENT_LINK_CURRENCY) {
        return fail(409, "Card-on-file links are ZAR only. This recurring schedule is in another currency.");
      }
      if (mandate.amountCents !== amountCents) {
        return fail(409, "This invoice's amount differs from its recurring schedule's. Fix one of them first.");
      }
      recurringInvoiceId = schedule.id;
    }
    // One live link per invoice: a second click hands back the open one, so
    // the customer can't be sent two links and pay both. A deactivated or
    // paid link doesn't count. An open link issued in the OTHER mode can no
    // longer be paid (see `loadPayableLink`), and one of the other kind
    // (card-on-file vs plain) is not what was asked for: both are withdrawn
    // and replaced.
    const existing = await db
      .collection("paymentLinks")
      .where("subAccountId", "==", input.subAccountId)
      .where("invoiceId", "==", input.invoiceId)
      .get();
    const openLinks = existing.docs.filter((d) => {
      const l = d.data() as PaymentLink;
      return l.active && l.status === "open";
    });
    const open = openLinks.find((d) => {
      const l = d.data() as PaymentLink;
      return l.mode === mode && !!l.mandate === !!input.mandate;
    });
    if (open) return { ok: true, link: { id: open.id, ...(open.data() as Omit<PaymentLink, "id">) } };
    for (const stale of openLinks) {
      await stale.ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    }
    invoiceId = input.invoiceId;
    contactId = quote.contactId ?? null;
    description = `Invoice ${quote.quoteNumber}`;
  } else {
    const amount = input.amountCents;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
      return fail(400, "Enter an amount between R0.01 and R1,000,000.");
    }
    const desc = typeof input.description === "string" ? input.description.trim() : "";
    if (!desc || desc.length > MAX_DESCRIPTION) {
      return fail(400, `Describe what the payment is for (up to ${MAX_DESCRIPTION} characters).`);
    }
    amountCents = amount;
    description = desc;
  }

  const ref = db.collection("paymentLinks").doc();
  const data: Omit<PaymentLink, "id"> = {
    agencyId: sub.agencyId as string,
    subAccountId: input.subAccountId,
    createdByUid: input.uid,
    invoiceId,
    contactId,
    description,
    amountCents,
    currency: PAYMENT_LINK_CURRENCY,
    mode,
    ...(mandate ? { mandate, recurringInvoiceId } : {}),
    token: issuePaymentLinkToken(ref.id),
    active: true,
    status: "open",
    paystackReference: null,
    payerEmail: null,
    paidAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(data);
  return { ok: true, link: { id: ref.id, ...data } };
}

export async function deactivatePaymentLink(input: {
  subAccountId: string;
  linkId: string;
}): Promise<ServiceResult<object>> {
  const ref = getAdminDb().doc(`paymentLinks/${input.linkId}`);
  const link = (await ref.get()).data() as PaymentLink | undefined;
  if (!link || link.subAccountId !== input.subAccountId) {
    return fail(404, "Payment link not found");
  }
  await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
}

/**
 * The link behind a public token, or why it can't be paid. Shared by the pay
 * page's GET (show it) and POST (start checkout) so both refuse the same links.
 */
export async function loadPayableLink(
  token: string,
  opts: { returning?: boolean } = {},
): Promise<ServiceResult<{ link: PaymentLink; mode: PaymentMode | null }>> {
  const linkId = verifyPaymentLinkToken(token);
  if (!linkId) return fail(404, "The link may be incomplete. Ask for a fresh payment link.");
  const snap = await getAdminDb().doc(`paymentLinks/${linkId}`).get();
  const data = snap.data() as Omit<PaymentLink, "id"> | undefined;
  if (!data || data.token !== token) {
    return fail(404, "The link may be incomplete. Ask for a fresh payment link.");
  }
  const link = { id: linkId, ...data };
  if (link.status === "paid") return fail(410, "This has already been paid — nothing more to pay.");
  if (!link.active) return fail(410, "This payment link has been withdrawn. Contact the sender if you think that's a mistake.");
  // Re-checked at pay time, like the Stripe invoice pay route: the agency may
  // have switched Payments off since the link went out. The webhook does NOT
  // check this — a payment already taken is recorded regardless.
  const sub = (await getAdminDb().doc(`subAccounts/${link.subAccountId}`).get()).data();
  if (sub?.paymentsEnabledByAgency !== true) {
    return fail(409, "Online payment isn't available for this link. Please contact the sender.");
  }

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
  // A payer back from Paystack is only told their payment is being confirmed:
  // telling them the link is dead could prompt a second payment.
  if (opts.returning) return { ok: true, link, mode: null };
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

const RETIRED = "This payment link is no longer valid. Ask the sender for a fresh payment link.";

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

/**
 * Open a Paystack checkout for a link. The amount is the doc's — the caller
 * supplies only the payer's email, and nothing else from the request reaches
 * Paystack.
 *
 * The `paymentAttempts/{reference}` record is committed BEFORE Paystack is
 * called, in a transaction that reads the connection: a disconnect or key
 * switch that lands first makes the transaction retry and see it, and one
 * that lands after finds this attempt open and flags it. Checkout then uses
 * exactly the key the attempt recorded.
 */
export async function startPaymentLinkCheckout(input: {
  token: string;
  email: string;
  /** The payer's IP — consent evidence on a card-on-file link. */
  ip: string;
}): Promise<ServiceResult<{ url: string }>> {
  const loaded = await loadPayableLink(input.token);
  if (!loaded.ok) return loaded;
  const { link } = loaded;

  const db = getAdminDb();
  const reference = paymentLinkReference(link.id);
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  const opened = await db.runTransaction(async (t) => {
    const conn = await readPaystackConnectionSecret(link.subAccountId, t);
    if (!conn) return fail(503, "Online payment is unavailable right now. Please contact the sender.");
    const mode = paystackKeyMode(conn.secretKey);
    if (mode !== link.mode) return fail(410, RETIRED);
    const attempt: Omit<PaymentAttempt, "id"> = {
      agencyId: link.agencyId,
      subAccountId: link.subAccountId,
      createdByUid: link.createdByUid,
      paymentLinkId: link.id,
      amountCents: link.amountCents,
      currency: link.currency,
      // Clicking pay under the terms shown is the consent: the same stored
      // wording, the server's clock, the payer's IP.
      ...(link.mandate ? { consent: { text: link.mandate.text, acceptedAt: new Date(), ip: input.ip } } : {}),
      mode,
      keyFingerprint: paystackKeyFingerprint(conn.secretKey),
      state: "open",
      reason: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    t.create(attemptRef, attempt);
    return { ok: true as const, secretKey: conn.secretKey };
  });
  if (!opened.ok) return opened;

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  try {
    const { url } = await initializePaystackTransaction({
      email: input.email,
      amountCents: link.amountCents,
      currency: link.currency,
      // Paystack sends the payer back here. The page only reads the link's
      // status; it is the webhook that marks it paid.
      callbackUrl: `${base}/pay/link/${input.token}`,
      reference,
      metadata: { paymentLinkId: link.id, subAccountId: link.subAccountId },
      displayName: link.description,
      // Only a card can be charged again; bank or EFT would save nothing.
      ...(link.mandate ? { channels: ["card"] } : {}),
      secretKey: opened.secretKey,
    });
    return { ok: true, url };
  } catch (err) {
    // Paystack opened no checkout, so nothing can be charged on this
    // reference. If this write fails too the attempt stays open, and at
    // worst a later disconnect flags a checkout that never took money.
    await attemptRef
      .update({ state: "refused", reason: "Paystack did not open the checkout.", updatedAt: FieldValue.serverTimestamp() })
      .catch((e: unknown) => console.error(`[payment-links] attempt ${reference} not marked refused`, e));
    if (err instanceof BillingError) return fail(502, err.message);
    throw err;
  }
}

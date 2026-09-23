import "server-only";

import { FieldValue, type Transaction } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { formatCurrency } from "@/lib/format";
import type { PaystackVerifiedTransaction } from "@/lib/paystack/billing-api";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { Cadence } from "@/lib/recurring/cadence";
import type { ServiceResult } from "@/lib/server/payment-links-service";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { PaymentLink } from "@/types/payment-links";
import {
  paymentMandateSecretPath,
  type MandateTerms,
  type PaymentMandate,
  type PaymentMandateSecret,
} from "@/types/payment-mandates";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * Card-on-file mandates: the terms a card-on-file link offers, the mandate a
 * verified payment of one creates, and the two ways a mandate stops being
 * chargeable — the connection changing under it, and the operator revoking.
 * Charging a mandate is not here (W5 PR3).
 */

/** "every month", "every 2 weeks". */
export function cadenceFrequency({ unit, interval }: Cadence): string {
  const n = Math.max(1, Math.trunc(interval));
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

/** The schedule's per-cycle amount, in cents, from its template. */
function scheduleTotalCents(schedule: RecurringInvoiceDoc): number {
  return Math.round(computeQuoteTotals(schedule).total * 100);
}

/** An active schedule of this sub-account, or null. */
export async function loadActiveSchedule(
  subAccountId: string,
  recurringInvoiceId: string | null | undefined,
): Promise<RecurringInvoiceDoc | null> {
  if (!recurringInvoiceId) return null;
  const data = (await getAdminDb().doc(`recurringInvoices/${recurringInvoiceId}`).get()).data();
  if (!data || data.subAccountId !== subAccountId || data.status !== "active") return null;
  return { ...(data as Omit<RecurringInvoiceDoc, "id">), id: recurringInvoiceId };
}

/** What the customer agrees to by paying: amount, frequency, how to stop. */
export function mandateTerms(business: string, schedule: RecurringInvoiceDoc): MandateTerms {
  const amountCents = scheduleTotalCents(schedule);
  const currency = (schedule.currency || "").toUpperCase();
  const frequency = cadenceFrequency(schedule.cadence);
  const amount = formatCurrency(amountCents / 100, currency);
  return {
    amountCents,
    currency,
    frequency,
    text:
      `By paying, you authorise ${business} to save this card and charge it ${amount} ${frequency} ` +
      `for this recurring invoice until you cancel. To stop future charges, ask ${business} to cancel: ` +
      `they remove the card in one click, and nothing further is charged.`,
  };
}

/** Do a link's terms still describe its schedule? */
export function termsStillHold(terms: MandateTerms, schedule: RecurringInvoiceDoc | null): boolean {
  return (
    !!schedule &&
    scheduleTotalCents(schedule) === terms.amountCents &&
    cadenceFrequency(schedule.cadence) === terms.frequency
  );
}

export type MandatePlan =
  | { mandate: Omit<PaymentMandate, "id">; secret: PaymentMandateSecret }
  | { reason: string };

/**
 * The mandate a verified payment of a card-on-file link creates, or why it
 * creates none. Every fact comes from Paystack's verify answer (`tx`) and our
 * own attempt — never from the webhook body. The caller has already matched
 * `tx` to the attempt on key, domain, amount and currency.
 */
export function planMandate(
  link: PaymentLink,
  attempt: PaymentAttempt,
  tx: PaystackVerifiedTransaction,
): MandatePlan {
  const auth = tx.authorization;
  const code = auth?.authorization_code;
  const customerCode = tx.customer?.customer_code;
  const email = tx.customer?.email;
  const why = !attempt.consent
    ? "no consent was recorded for this checkout"
    : auth?.channel !== "card"
      ? "it was not paid by card"
      : auth.reusable !== true
        ? "Paystack marked the card as not reusable"
        : !code || !customerCode || !email
          ? "Paystack returned no usable authorization"
          : null;
  if (why || !link.mandate || !link.recurringInvoiceId) {
    return {
      reason: `Paid, but the card was not saved for future charges: ${why ?? "the link carries no terms"}. Send a new card-on-file link, or bill this customer by invoice.`,
    };
  }
  return {
    mandate: {
      agencyId: link.agencyId,
      subAccountId: link.subAccountId,
      createdByUid: link.createdByUid,
      contactId: link.contactId,
      recurringInvoiceId: link.recurringInvoiceId,
      paymentLinkId: link.id,
      reference: attempt.id,
      terms: link.mandate,
      consent: attempt.consent!,
      cardBrand: auth!.brand ?? auth!.card_type ?? null,
      last4: auth!.last4 ?? null,
      expMonth: auth!.exp_month ?? null,
      expYear: auth!.exp_year ?? null,
      mode: attempt.mode,
      keyFingerprint: attempt.keyFingerprint,
      status: "active",
      attention: null,
      revokedAt: null,
      revokedByUid: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    secret: { authorizationCode: code!, customerCode: customerCode!, email: email!, signature: auth!.signature ?? null },
  };
}

/**
 * Inside the transaction that marks the link paid: store the plan's mandate
 * (id = the payment's reference, so it is written once), and return the
 * link fields that record the outcome.
 */
export function writeMandate(t: Transaction, plan: MandatePlan): Pick<PaymentLink, "mandateId" | "mandateAttention"> {
  if ("reason" in plan) return { mandateId: null, mandateAttention: plan.reason };
  const db = getAdminDb();
  const id = plan.mandate.reference;
  t.set(db.doc(`paymentMandates/${id}`), plan.mandate);
  t.set(db.doc(paymentMandateSecretPath(id)), plan.secret);
  return { mandateId: id, mandateAttention: null };
}

/**
 * After the connection changed: every ACTIVE mandate made under a key other
 * than `currentFingerprint` (null = disconnected) needs attention — its
 * authorization lives on a Paystack account this workspace no longer holds.
 * Every mandate is tried, then the call fails if any write did, so the
 * operator sees an error and a retry finishes the job.
 */
export async function flagStaleMandates(subAccountId: string, currentFingerprint: string | null): Promise<void> {
  const db = getAdminDb();
  const active = await db
    .collection("paymentMandates")
    .where("subAccountId", "==", subAccountId)
    .where("status", "==", "active")
    .get();
  const reason = currentFingerprint
    ? "The Paystack key was changed since this card was saved, so it can no longer be charged. Send the customer a new card-on-file link."
    : "Paystack was disconnected since this card was saved, so it can no longer be charged. Reconnect Paystack and send the customer a new card-on-file link.";
  const failed: string[] = [];
  for (const doc of active.docs) {
    if ((doc.data() as PaymentMandate).keyFingerprint === currentFingerprint) continue;
    try {
      await db.runTransaction(async (t) => {
        const fresh = (await t.get(doc.ref)).data() as PaymentMandate | undefined;
        // Only ever active → attention: never over a revoke, never twice.
        if (fresh?.status !== "active") return;
        t.update(doc.ref, { status: "attention", attention: reason, updatedAt: FieldValue.serverTimestamp() });
      });
    } catch (err) {
      console.error(`[payment-mandates] sa=${subAccountId} mandate=${doc.id} could not be flagged`, err);
      failed.push(doc.id);
    }
  }
  if (failed.length) throw new Error(`Could not flag ${failed.length} saved card(s): ${failed.join(", ")}`);
}

/**
 * Revoke, for good: the status goes to `revoked` and the authorization is
 * deleted in the same transaction, so nothing can charge the card again —
 * not even a bug that ignored the status. Revoking twice keeps the first.
 */
export async function revokePaymentMandate(input: {
  subAccountId: string;
  mandateId: string;
  uid: string;
}): Promise<ServiceResult<object>> {
  const notFound = { ok: false as const, status: 404, error: "Saved card not found" };
  if (!/^[A-Za-z0-9-]{1,100}$/.test(input.mandateId)) return notFound;
  const db = getAdminDb();
  const ref = db.doc(`paymentMandates/${input.mandateId}`);
  return db.runTransaction(async (t) => {
    const mandate = (await t.get(ref)).data() as PaymentMandate | undefined;
    if (!mandate || mandate.subAccountId !== input.subAccountId) return notFound;
    if (mandate.status === "revoked") return { ok: true as const };
    t.update(ref, {
      status: "revoked",
      revokedAt: FieldValue.serverTimestamp(),
      revokedByUid: input.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    t.delete(db.doc(paymentMandateSecretPath(input.mandateId)));
    return { ok: true as const };
  });
}

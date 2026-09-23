import "server-only";

import { FieldValue, type Transaction } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { formatCurrency } from "@/lib/format";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import type { PaystackVerifiedTransaction } from "@/lib/paystack/billing-api";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { Cadence } from "@/lib/recurring/cadence";
import type { ServiceResult } from "@/lib/server/payment-links-service";
import type { PaymentAttempt } from "@/types/payment-attempts";
import { PAYMENT_LINK_CURRENCY, type PaymentLink } from "@/types/payment-links";
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

/** An active schedule of this sub-account, or null. Pass `t` to read it in a transaction. */
export async function loadActiveSchedule(
  subAccountId: string,
  recurringInvoiceId: string | null | undefined,
  t?: Transaction,
): Promise<RecurringInvoiceDoc | null> {
  if (!recurringInvoiceId) return null;
  const ref = getAdminDb().doc(`recurringInvoices/${recurringInvoiceId}`);
  const data = (t ? await t.get(ref) : await ref.get()).data();
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

/** Do a link's terms still describe its schedule? Charges are in ZAR only. */
export function termsStillHold(terms: MandateTerms, schedule: RecurringInvoiceDoc | null): boolean {
  return (
    !!schedule &&
    (schedule.currency || "").toUpperCase() === PAYMENT_LINK_CURRENCY &&
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
  if (why || !link.mandate || !link.recurringInvoiceId) return { reason: notSaved(why ?? "the link carries no terms") };
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

/** When the customer consented; Timestamp once stored, Date before. */
function consentMillis(m: Pick<PaymentMandate, "consent">): number {
  const at = m.consent?.acceptedAt as { toMillis?: () => number; getTime?: () => number } | undefined;
  return at?.toMillis?.() ?? at?.getTime?.() ?? Number.NEGATIVE_INFINITY;
}

const notSaved = (why: string) =>
  `Paid, but the card was not saved for future charges: ${why}. Send a new card-on-file link, or bill this customer by invoice.`;

type MandateOutcome = Pick<PaymentLink, "mandateId" | "mandateAttention">;

/**
 * Inside the transaction that marks the link paid, BEFORE its writes
 * (Firestore reads first): re-check what the consent depends on, from the
 * transaction's own reads — the link is still live, the schedule still
 * matches the terms agreed to, and the connection still holds the key the
 * card was taken under. A pause, re-price, withdrawal or key change that
 * commits meanwhile is either seen here or retries the transaction, so it
 * can never leave an active mandate behind (a key change's own flag pass
 * runs after its commit and so sees any mandate committed before it).
 *
 * Returns the writer, called with the link update: it stores the mandate
 * (id = the payment's reference, so written once), revokes the schedule's
 * other mandates, and points the schedule at it (`cardMandateId`). "Newer"
 * is the customer's CONSENT time, not settle time: a late webhook for an
 * older consent saves nothing once any card — even a revoked one — was
 * authorised more recently. Every settle writes the schedule doc it read,
 * so two settles for one schedule conflict and one retries, seeing the other.
 */
export async function prepareMandate(
  t: Transaction,
  plan: MandatePlan,
  linkActive: boolean,
): Promise<() => MandateOutcome> {
  if ("reason" in plan) return () => ({ mandateId: null, mandateAttention: plan.reason });
  const { mandate, secret } = plan;
  const db = getAdminDb();
  const scheduleRef = db.doc(`recurringInvoices/${mandate.recurringInvoiceId}`);
  const schedule = await loadActiveSchedule(mandate.subAccountId, mandate.recurringInvoiceId, t);
  const conn = await readPaystackConnectionSecret(mandate.subAccountId, t);
  const older = await t.get(
    db.collection("paymentMandates")
      .where("subAccountId", "==", mandate.subAccountId)
      .where("recurringInvoiceId", "==", mandate.recurringInvoiceId),
  );
  const why = !linkActive
    ? "the link was withdrawn before the payment completed"
    : !termsStillHold(mandate.terms, schedule)
      ? "the recurring schedule changed or stopped after the customer agreed to its terms"
      : !conn || paystackKeyFingerprint(conn.secretKey) !== mandate.keyFingerprint
        ? "the Paystack connection changed while the payment was being confirmed"
        : older.docs.some((d) => consentMillis(d.data() as PaymentMandate) >= consentMillis(mandate))
          ? "the customer authorised a card for this schedule more recently"
          : null;
  if (why) return () => ({ mandateId: null, mandateAttention: notSaved(why) });

  const id = mandate.reference;
  return () => {
    for (const doc of older.docs) {
      if ((doc.data() as PaymentMandate).status === "revoked") continue;
      t.update(doc.ref, {
        status: "revoked",
        attention: `Replaced by the card saved with payment ${id}.`,
        revokedAt: FieldValue.serverTimestamp(),
        revokedByUid: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      t.delete(db.doc(paymentMandateSecretPath(doc.id)));
    }
    t.set(db.doc(`paymentMandates/${id}`), mandate);
    t.set(db.doc(paymentMandateSecretPath(id)), secret);
    t.update(scheduleRef, { cardMandateId: id, updatedAt: FieldValue.serverTimestamp() });
    return { mandateId: id, mandateAttention: null };
  };
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

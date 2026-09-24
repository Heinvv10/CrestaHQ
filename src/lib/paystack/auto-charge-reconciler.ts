import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatCurrency } from "@/lib/format";
import {
  verifyPaystackTransaction,
  type PaystackVerifiedTransaction,
} from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import type { PaymentLinkReconcileResult } from "@/lib/paystack/payment-link-reconciler";
import { raiseChargeTask } from "@/lib/server/auto-charge-alerts";
import { loadPaymentAttempt } from "@/lib/server/payment-attempts";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { fireChargeTrigger } from "@/lib/server/recurring-auto-charge";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { Quote, QuotePaidVia } from "@/types/quotes";

/**
 * Paystack `charge.success` for a recurring card cycle (`ra-{scheduleId}-c{n}`,
 * see `recurring-auto-charge.ts`) → that cycle's invoice paid, with
 * `paidVia.rail = "paystack_auto"`. The only place an auto-charge is recorded:
 * the charge call's own answer never marks anything paid.
 *
 * Same trust rules as the payment-link reconciler: the body gives only the
 * reference; the facts come from Paystack's verify answer with the tenant's
 * key, and must match our own attempt on key, mode (`domain`), amount and
 * currency. A mismatch flags the attempt, raises a Task, records nothing. Never throws;
 * `retry: true` only when Paystack or Firestore could not answer.
 */

/** Paystack answered that the reference does not exist on this account. */
function isNotFound(err: unknown): boolean {
  if (!(err instanceof BillingError)) return false;
  return err.providerStatus === 404 || (err.providerStatus === 400 && /not found/i.test(err.message));
}

/** What was asked for, before customer-borne fees — see the link reconciler. */
function requestedAmount(tx: PaystackVerifiedTransaction): number {
  return typeof tx.requested_amount === "number" ? tx.requested_amount : tx.amount;
}

export async function reconcileAutoCharge(input: {
  subAccountId: string;
  secretKey: string;
  reference: string;
}): Promise<PaymentLinkReconcileResult> {
  const { subAccountId, secretKey, reference } = input;
  const tag = `[paystack/auto-charge] sa=${subAccountId} ref=${reference}`;
  try {
    const attempt = await loadPaymentAttempt(reference);
    if (!attempt || attempt.subAccountId !== subAccountId || !attempt.mandateId || !attempt.invoiceId) {
      console.error(`${tag} no auto-charge attempt for this sub-account`);
      return { handled: false, detail: "no matching auto-charge attempt" };
    }
    if (attempt.keyFingerprint !== paystackKeyFingerprint(secretKey)) {
      console.error(`${tag} not marking paid: verifying key is not the attempt's`);
      await alertOnce(
        attempt,
        `Paystack reported a saved-card charge (reference ${reference}) under a different key than its ${attempt.mode}-mode attempt used, and it was not recorded. Check your Paystack dashboard.`,
        (invoice) => `Card payment not recorded: invoice ${invoice} (the Paystack key changed)`,
        { flag: true },
      );
      return { handled: false, detail: "mismatch key" };
    }

    let tx: PaystackVerifiedTransaction;
    try {
      tx = await verifyPaystackTransaction(reference, secretKey);
    } catch (err) {
      console.error(`${tag} verify failed`, err);
      return isNotFound(err)
        ? { handled: false, detail: "verify: not found" }
        : { handled: false, retry: true, detail: "verify unavailable" };
    }
    if (tx.status !== "success" || tx.reference !== reference) {
      console.error(`${tag} not marking paid: status=${tx.status} reference=${tx.reference}`);
      return { handled: false, detail: "not a success for this reference" };
    }
    const amount = requestedAmount(tx);
    const mismatch =
      amount !== attempt.amountCents
        ? `amount=${amount} expected=${attempt.amountCents}`
        : tx.amount < amount
          ? `partial amount=${tx.amount} requested=${amount}`
          : (tx.currency ?? "").toUpperCase() !== attempt.currency
            ? `currency=${tx.currency} expected=${attempt.currency}`
            : tx.domain !== attempt.mode
              ? `mode domain=${tx.domain} attempt=${attempt.mode}`
              : null;
    if (mismatch) {
      console.error(`${tag} not marking paid: ${mismatch}`);
      await alertOnce(
        attempt,
        mismatch.startsWith("mode")
          ? `A ${tx.domain ?? "unknown"}-mode payment (reference ${reference}) arrived for a ${attempt.mode}-mode saved-card charge, and was not recorded. Check your Paystack dashboard.`
          : `Paystack received a saved-card payment (reference ${reference}) that does not match its charge — check your Paystack dashboard.`,
        (invoice) => `Card payment not recorded: invoice ${invoice}`,
        { flag: true },
      );
      return { handled: false, detail: `mismatch ${mismatch}` };
    }

    if (!(await settleAttempt(reference))) {
      console.error(`${tag} succeeded at Paystack after it was recorded as declined`);
      await alertOnce(
        attempt,
        `Paystack later reported this charge (reference ${reference}) as paid, after it was recorded as declined. ` +
          `Check your Paystack dashboard: if the invoice is unpaid, mark it paid by hand; if it was paid another way, a refund may be owed.`,
        (invoice) => `Card charged after its decline: invoice ${invoice} may be paid twice`,
      );
      const quoteRef = getAdminDb().doc(`quotes/${attempt.invoiceId}`);
      // The invoice still reads "declined" (and, unpaid, offers a pay link); say otherwise.
      await getAdminDb().runTransaction(async (t) => {
        const invoice = (await t.get(quoteRef)).data() as Quote | undefined;
        const live = invoice?.autoCharge;
        if (live?.reference !== reference || live.state !== "declined") return;
        const late = `Paystack later reported this card charge (reference ${reference}) as paid, after it was recorded as declined`;
        const why =
          invoice!.status !== "paid"
            ? `${late}. Check your Paystack dashboard and mark the invoice paid by hand — do not send a pay link.`
            : invoice!.paidVia
              ? `${late}, and the invoice was also paid by ${describeVia(invoice!.paidVia)}. The customer paid twice: a refund is owed.`
              : `${late}, and the invoice was marked paid by hand. If the hand mark recorded a different payment, the customer paid twice and a refund may be owed.`;
        t.update(quoteRef, { autoCharge: { ...live, state: "needs_attention", reason: why }, updatedAt: FieldValue.serverTimestamp() });
      });
      return { handled: false, detail: "attempt was refused" };
    }
    return await settleInvoice(attempt, subAccountId, reference, tag);
  } catch (err) {
    console.error(`${tag} reconcile failed`, err);
    return { handled: false, retry: true, detail: "error" };
  }
}

/**
 * open/flagged → settled; settled stays settled (a replay still re-runs the
 * invoice step, which recognises its own earlier success). A `refused`
 * attempt — the charge call was read as a decline, and the invoice emailed —
 * is not settled: the caller tells the operator the money arrived after all.
 */
async function settleAttempt(reference: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`paymentAttempts/${reference}`);
  return db.runTransaction(async (t) => {
    const state = ((await t.get(ref)).data() as PaymentAttempt | undefined)?.state;
    if (state === "settled") return true;
    if (state === "refused") return false;
    t.update(ref, { state: "settled", updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

/**
 * Record `why` on the attempt and raise a Task for it — once. The reason is
 * written in a transaction, and only the call that changes it raises the
 * Task, so a webhook redelivery (which finds the same reason) adds nothing.
 * `flag` also marks the attempt flagged — money arrived that was not recorded
 * — unless it is already settled (a late redelivery under a newer key).
 *
 * If the Task cannot be created the reason is put back and the error thrown:
 * the webhook answers 503, and Paystack's redelivery raises it.
 */
async function alertOnce(
  attempt: PaymentAttempt,
  why: string,
  title: (invoice: string) => string,
  opts: { flag?: boolean } = {},
): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`paymentAttempts/${attempt.id}`);
  const before = await db.runTransaction(async (t) => {
    const current = (await t.get(ref)).data() as PaymentAttempt | undefined;
    if (!current || current.reason === why || (opts.flag && current.state === "settled")) return null;
    const flag = opts.flag && current.state !== "flagged";
    t.update(ref, { reason: why, ...(flag ? { state: "flagged" } : {}), updatedAt: FieldValue.serverTimestamp() });
    return { reason: current.reason, state: flag ? current.state : null };
  });
  if (!before) return;
  try {
    const invoice = (await db.doc(`quotes/${attempt.invoiceId}`).get()).data() as Quote | undefined;
    const owner = { ...attempt, contactId: invoice?.contactId ?? null };
    await raiseChargeTask(owner, title(invoice?.quoteNumber || attempt.invoiceId!), why);
  } catch (err) {
    await db.runTransaction(async (t) => {
      const current = (await t.get(ref)).data() as PaymentAttempt | undefined;
      if (current?.reason !== why) return;
      const state = before.state && current.state === "flagged" ? { state: before.state } : {};
      t.update(ref, { reason: before.reason, ...state, updatedAt: FieldValue.serverTimestamp() });
    });
    throw err;
  }
}

/** Who else paid the invoice, for the operator. */
function describeVia(via: QuotePaidVia | null | undefined): string {
  if (!via) return "marked paid by hand";
  if (via.rail === "stripe_order") return `a Stripe card payment (order ${via.orderId})`;
  return via.rail === "paystack_link"
    ? `a payment link, Paystack reference ${via.reference}`
    : `another saved-card charge, Paystack reference ${via.reference}`;
}

async function settleInvoice(
  attempt: PaymentAttempt,
  subAccountId: string,
  reference: string,
  tag: string,
): Promise<PaymentLinkReconcileResult> {
  const db = getAdminDb();
  const mandateId = attempt.mandateId!;
  const ours = (via: QuotePaidVia | null | undefined) => via?.rail === "paystack_auto" && via.reference === reference;
  const res = await markQuotePaidServerSide({
    quoteId: attempt.invoiceId!,
    expectSubAccountId: subAccountId,
    paidVia: { rail: "paystack_auto", mandateId, reference },
    expectTotalCents: attempt.amountCents,
    expectCurrency: attempt.currency,
  });
  if (res.ok) {
    // Only the compare-and-set winner gets here, once. A failed note below
    // must not skip the trigger — a redelivery would find already_paid.
    const log = (what: string) => (err: unknown) => console.error(`${tag} ${what}`, err);
    await db
      .doc(`quotes/${attempt.invoiceId}`)
      .update({ autoCharge: { reference, mandateId, state: "paid", reason: null }, updatedAt: FieldValue.serverTimestamp() })
      .catch(log("invoice autoCharge not written"));
    await db
      .doc(`paymentMandates/${mandateId}`)
      .update({ consecutiveDeclines: 0, updatedAt: FieldValue.serverTimestamp() })
      .catch(log("mandate decline count not reset"));
    await fireChargeTrigger(res.quote, "invoice.charge_succeeded");
    return { handled: true, detail: `invoice ${attempt.invoiceId} paid` };
  }
  if (res.code === "already_paid" && ours(res.paidVia)) {
    return { handled: true, detail: "already recorded (idempotent no-op)" };
  }

  // The money is in the tenant's account either way; the operator is told why
  // it is not recorded against this invoice.
  const charged = `Charged (Paystack reference ${reference})`;
  // Marked paid by hand while this charge was still unconfirmed: the hand
  // mark may BE this payment, so the Task says so rather than claim a refund.
  const handMarked =
    res.code === "already_paid" && !res.paidVia
      ? ((await db.doc(`quotes/${attempt.invoiceId}`).get()).data() as Quote | undefined)
      : undefined;
  const beforeConfirmed = handMarked?.autoCharge?.reference === reference;
  const why = beforeConfirmed
    ? `Invoice ${handMarked!.quoteNumber || attempt.invoiceId} was marked paid by hand before Paystack confirmed saved-card charge ${reference} ` +
      `(${formatCurrency(attempt.amountCents / 100, attempt.currency)}). If the hand mark recorded this card charge, there is nothing to do. ` +
      `If it recorded a different payment, the customer paid twice and a refund may be owed.`
    : res.code === "already_paid"
      ? `${charged}, but the invoice was already paid another way (${describeVia(res.paidVia)}) — a refund may be owed.`
      : res.code === "amount_changed"
        ? `${charged}, but the invoice changed after the charge, so it was not marked paid. Check the amount and mark it by hand.`
        : res.code === "not_found" || res.code === "wrong_tenant"
          ? `${charged}, but the invoice no longer exists, so it was not marked paid. Record this payment by hand.`
          : `${charged}, but the invoice could not be marked paid: ${res.message}. Record this payment by hand.`;
  console.error(`${tag} ${why}`);
  await alertOnce(attempt, why, (invoice) =>
    beforeConfirmed
      ? `Check a hand-marked invoice: ${invoice}`
      : res.code === "already_paid"
        ? `Refund may be owed: invoice ${invoice} was paid twice`
        : `Record a card payment by hand: invoice ${invoice}`,
  );
  if (res.code !== "not_found" && res.code !== "wrong_tenant") {
    await db.doc(`quotes/${attempt.invoiceId}`).update({
      autoCharge: { reference, mandateId, state: "needs_attention", reason: why },
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { handled: true, detail: why };
}

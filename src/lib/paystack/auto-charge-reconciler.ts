import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  verifyPaystackTransaction,
  type PaystackVerifiedTransaction,
} from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import type { PaymentLinkReconcileResult } from "@/lib/paystack/payment-link-reconciler";
import { flagPaymentAttempt, loadPaymentAttempt } from "@/lib/server/payment-attempts";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { fireChargeTrigger } from "@/lib/server/recurring-auto-charge";
import type { PaymentAttempt } from "@/types/payment-attempts";
import type { QuotePaidVia } from "@/types/quotes";

/**
 * Paystack `charge.success` for a recurring card cycle (`ra-{scheduleId}-c{n}`,
 * see `recurring-auto-charge.ts`) → that cycle's invoice paid, with
 * `paidVia.rail = "paystack_auto"`. The only place an auto-charge is recorded:
 * the charge call's own answer never marks anything paid.
 *
 * Same trust rules as the payment-link reconciler: the body gives only the
 * reference; the facts come from Paystack's verify answer with the tenant's
 * key, and must match our own attempt on key, mode (`domain`), amount and
 * currency. A mismatch flags the attempt and records nothing. Never throws;
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
      await flagPaymentAttempt(reference, (a) =>
        `Paystack reported a saved-card charge (reference ${reference}) under a different key than its ${a.mode}-mode attempt used, and it was not recorded. Check your Paystack dashboard.`,
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
      await flagPaymentAttempt(reference, (a) =>
        mismatch.startsWith("mode")
          ? `A ${tx.domain ?? "unknown"}-mode payment (reference ${reference}) arrived for a ${a.mode}-mode saved-card charge, and was not recorded. Check your Paystack dashboard.`
          : `Paystack received a saved-card payment (reference ${reference}) that does not match its charge — check your Paystack dashboard.`,
      );
      return { handled: false, detail: `mismatch ${mismatch}` };
    }

    if (!(await settleAttempt(reference))) {
      console.error(`${tag} succeeded at Paystack after it was recorded as declined`);
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
 * is not settled: its reason tells the operator the money arrived after all.
 */
async function settleAttempt(reference: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`paymentAttempts/${reference}`);
  return db.runTransaction(async (t) => {
    const state = ((await t.get(ref)).data() as PaymentAttempt | undefined)?.state;
    if (state === "settled") return true;
    if (state === "refused") {
      t.update(ref, {
        reason:
          `Paystack later reported this charge (reference ${reference}) as paid, after it was recorded as declined and the invoice was emailed. ` +
          `Check your Paystack dashboard: mark the invoice paid by hand, or refund a second payment.`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return false;
    }
    t.update(ref, { state: "settled", updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
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
  const why =
    res.code === "already_paid"
      ? "Charged, but the invoice was already paid another way — a refund may be owed."
      : res.code === "amount_changed"
        ? "Charged, but the invoice changed after the charge, so it was not marked paid. Check the amount and mark it by hand."
        : `Charged, but the invoice could not be marked paid: ${res.message}. Record this payment by hand.`;
  console.error(`${tag} ${why}`);
  await db.doc(`paymentAttempts/${reference}`).update({ reason: why, updatedAt: FieldValue.serverTimestamp() });
  if (res.code !== "not_found" && res.code !== "wrong_tenant") {
    await db.doc(`quotes/${attempt.invoiceId}`).update({
      autoCharge: { reference, mandateId, state: "needs_attention", reason: why },
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { handled: true, detail: why };
}

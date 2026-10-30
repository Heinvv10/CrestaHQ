import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { formatCurrency } from "@/lib/format";
import {
  verifyPaystackTransaction,
  type PaystackVerifiedTransaction,
} from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import type { PaymentLinkReconcileResult } from "@/lib/paystack/payment-link-reconciler";
import { isNotFound, requestedAmount } from "@/lib/paystack/verify-answer";
import { flagOrderAttention } from "@/lib/server/orders-service";
import { flagPaymentAttempt, loadPaymentAttempt } from "@/lib/server/payment-attempts";
import { parseProductOrderReference } from "@/lib/server/product-order-reference";
import { settleProductLinkPayment } from "@/lib/server/product-link-orders";
import { recoverFlaggedOrder } from "@/lib/server/product-link-paystack-orders";
import { finishPaidProductLinkOrder } from "@/lib/stripe/product-link-reconcile";
import type { Order } from "@/types/orders";
import type { PaymentAttempt } from "@/types/payment-attempts";

/**
 * Paystack `charge.success` for an express buy-page order (`po-{orderId}`, see
 * `product-order-reference.ts`) → that `product_link` order paid. The Paystack
 * twin of `handleProductLinkCompleted` (stripe/product-link-reconcile.ts): the
 * same `settleProductLinkPayment` is the only pending → paid transition, and
 * the same `finishPaidProductLinkOrder` runs the contact step, the `order.paid`
 * events and the one confirmation email, so a replay changes nothing.
 *
 * Same trust rules as the payment-link reconciler: the body gives only the
 * reference; the facts come from Paystack's verify answer with the tenant's
 * key, and must match our own attempt (key, mode) and the ORDER (amount,
 * currency, judged against the order as re-read inside the transaction). A
 * mismatch HOLDS the order (`heldAt`): never paid, never delivered, no release
 * path in the app; the attempt and the order are flagged for the operator.
 * Money for an order already failed is flagged, never dropped. A verified,
 * matching payment for an order whose attempt had been flagged (a key change)
 * pays it and lifts that flag (`recoverFlaggedOrder`).
 *
 * Never throws. `retry: true` only when Paystack or Firestore could not
 * answer, so the route answers non-200 and Paystack redelivers.
 */

const sameAmount = (tx: PaystackVerifiedTransaction, order: Pick<Order, "totalCents" | "currency">) =>
  requestedAmount(tx) === order.totalCents &&
  tx.amount >= requestedAmount(tx) &&
  (tx.currency ?? "").toLowerCase() === order.currency.toLowerCase();

/** Why the verified payment does not match the order, or null when it does. */
function mismatch(
  tx: PaystackVerifiedTransaction,
  order: Pick<Order, "totalCents" | "currency">,
  attempt: Pick<PaymentAttempt, "mode">,
): string | null {
  if (!sameAmount(tx, order)) {
    return `Paystack took ${formatCurrency(requestedAmount(tx) / 100, (tx.currency || "ZAR").toUpperCase())}, which differs from this order`;
  }
  if (tx.domain !== attempt.mode) {
    return `A ${tx.domain ?? "unknown"}-mode payment arrived for a ${attempt.mode}-mode checkout`;
  }
  return null;
}

export async function reconcileProductOrderCharge(input: {
  subAccountId: string;
  secretKey: string;
  reference: string;
}): Promise<PaymentLinkReconcileResult> {
  const { subAccountId, secretKey, reference } = input;
  const tag = `[paystack/product-order] sa=${subAccountId} ref=${reference}`;
  const orderId = parseProductOrderReference(reference);
  if (!orderId) return { handled: false, detail: "not a product-order reference" };

  try {
    const attempt = await loadPaymentAttempt(reference);
    // Attempts are committed before Paystack is called, so a reference without
    // one was made elsewhere on this account. Not ours to judge.
    if (!attempt || attempt.subAccountId !== subAccountId || attempt.orderId !== orderId) {
      console.error(`${tag} no matching attempt for this sub-account`);
      return { handled: false, detail: "no matching order attempt" };
    }
    // Verifying with a key other than the attempt's would ask a different
    // Paystack account about this reference. Terminal, and visible.
    if (attempt.keyFingerprint !== paystackKeyFingerprint(secretKey)) {
      console.error(`${tag} not marking paid: verifying key is not the attempt's`);
      await flagPaymentAttempt(reference, (a) =>
        `Paystack reported a payment (reference ${reference}) under a different key than its ${a.mode}-mode checkout used, and it was not recorded. Check your Paystack dashboard.`,
      );
      return { handled: false, detail: "mismatch key" };
    }

    const db = getAdminDb();
    const orderSnap = await db.doc(`orders/${orderId}`).get();
    const order = orderSnap.exists ? ({ id: orderSnap.id, ...orderSnap.data() } as Order) : null;
    if (!order || order.subAccountId !== subAccountId || order.source !== "product_link") {
      console.error(`${tag} order ${orderId} missing or not this sub-account's`);
      return { handled: false, detail: "order tenancy mismatch" };
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
    // Not a success, or not this reference: Paystack received nothing for it.
    if (tx.status !== "success" || tx.reference !== reference) {
      console.error(`${tag} not marking paid: status=${tx.status} reference=${tx.reference}`);
      return { handled: false, detail: "not a success for this reference" };
    }

    const email = tx.customer?.email?.trim().toLowerCase().slice(0, 254) || null;
    const settled = await settleProductLinkPayment({
      orderId,
      matches: (stored) => mismatch(tx, stored, attempt) === null,
      stripePaymentIntentId: null,
      buyerEmail: email,
      buyerName: null,
    });
    if (!settled) return { handled: true, detail: "order no longer exists" };

    if (settled.kind === "held") {
      const why = mismatch(tx, settled.order, attempt);
      // This delivery matches: the order was held by an earlier, mismatching
      // one, which already flagged why. Held for good; nothing to add.
      if (!why) return { handled: true, detail: `order ${orderId} held by an earlier delivery` };
      console.error(`${tag} order held: ${why}`);
      const note = `${why} (Paystack reference ${reference}). It was not marked paid and nothing was delivered. Refund it in Paystack, or settle it by hand.`;
      await flagPaymentAttempt(reference, () => note);
      // The attempt may already carry an older flag (a key change), whose
      // reason is what it put on the order: the order says why it is held.
      await flagOrderAttention(settled.order, note);
      return { handled: true, detail: `order ${orderId} held: mismatch` };
    }
    if (settled.kind === "closed") {
      const note = `Paid (Paystack reference ${reference}), but this order was already ${settled.order.status} — nothing was delivered. Refund the payment, or settle it by hand.`;
      await flagPaymentAttempt(reference, () => note);
      await flagOrderAttention(settled.order, note);
      return { handled: true, detail: `order ${orderId} is ${settled.order.status}` };
    }

    // The money is recorded: the attempt is settled. At least once — a crash
    // before this write is repaired by the replay, which lands here as "already".
    // A flag on the attempt ("may have paid, not recorded") is answered FIRST:
    // the attempt leaves "flagged" only afterwards, so a crash in between is
    // repaired by the replay too, and the confirmation below can go out.
    if (attempt.state === "flagged") await recoverFlaggedOrder(orderId, attempt.reason, reference);
    if (attempt.state !== "settled") {
      await db.doc(`paymentAttempts/${reference}`).update({
        state: "settled",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await finishPaidProductLinkOrder(settled.order, { email, name: null, phone: null });
    return {
      handled: true,
      detail: settled.kind === "paid" ? `order ${orderId} paid` : "already recorded (idempotent no-op)",
    };
  } catch (err) {
    console.error(`${tag} reconcile failed`, err);
    return { handled: false, retry: true, detail: "error" };
  }
}

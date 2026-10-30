import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { paystackKeyFingerprint, paystackKeyMode } from "@/lib/paystack/key-fingerprint";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { productOrderReference } from "@/lib/server/product-order-reference";
import type { Order } from "@/types/orders";
import type { PaymentAttempt } from "@/types/payment-attempts";
import { PAYMENT_LINK_CURRENCY } from "@/types/payment-links";

/**
 * The Paystack-rail state changes of an express buy-link order
 * (`source: "product_link"`), beside the generic ones in
 * product-link-orders.ts: the same single write path for `orders/{id}`, each
 * one a transaction that re-reads the order and changes it only from the
 * state it expects.
 */

export type PaystackAttemptOpened =
  | { ok: true; reference: string; secretKey: string }
  | { ok: false; reason: "order_unavailable" | "not_connected" | "wrong_currency" };

/**
 * Open the Paystack checkout of an order written before it: the one
 * `paymentAttempts/{reference}` record and the order's `paystackReference`,
 * committed together BEFORE Paystack is called. The transaction reads the
 * connection, so a disconnect or key switch that lands first makes it retry
 * and see it, and one that lands after finds this attempt open and flags it.
 * The checkout then uses exactly the key the attempt recorded. Only an order
 * still `pending` with no checkout yet is opened (once).
 */
export async function openPaystackAttempt(
  orderId: string,
  createdByUid: string,
): Promise<PaystackAttemptOpened> {
  const db = getAdminDb();
  const orderRef = db.doc(`orders/${orderId}`);
  const reference = productOrderReference(orderId);
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  return db.runTransaction(async (tx): Promise<PaystackAttemptOpened> => {
    const snap = await tx.get(orderRef);
    const order = snap.data() as Partial<Order> | undefined;
    const conn = order ? await readPaystackConnectionSecret(order.subAccountId ?? "", tx) : null;
    if (
      !order ||
      order.source !== "product_link" ||
      order.status !== "pending" ||
      order.heldAt ||
      order.stripeCheckoutSessionId !== "" ||
      order.paystackReference
    ) {
      return { ok: false, reason: "order_unavailable" };
    }
    if (!conn) return { ok: false, reason: "not_connected" };
    if ((order.currency ?? "").toUpperCase() !== PAYMENT_LINK_CURRENCY) {
      return { ok: false, reason: "wrong_currency" };
    }
    const mode = paystackKeyMode(conn.secretKey);
    const attempt: Omit<PaymentAttempt, "id"> = {
      agencyId: order.agencyId as string,
      subAccountId: order.subAccountId as string,
      createdByUid,
      // "" and not null: `recheckStaleAutoCharges` (auto-charge-stale-sweep.ts)
      // queries `paymentLinkId == null`, and abandoned buys would fill its page.
      paymentLinkId: "",
      orderId,
      amountCents: order.totalCents as number,
      currency: PAYMENT_LINK_CURRENCY,
      mode,
      keyFingerprint: paystackKeyFingerprint(conn.secretKey),
      state: "open",
      reason: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.create(attemptRef, attempt);
    tx.update(orderRef, {
      paystackReference: reference,
      livemode: mode === "live",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, reference, secretKey: conn.secretKey };
  });
}

/**
 * A verified, fully matching payment has settled an order whose attempt had
 * been flagged ("the customer may have paid and it was not recorded", e.g. a
 * key change). The flag is now wrong, so the order is not left holding the
 * buyer's download and confirmation hostage:
 *  - the order's only attention reason was that flag (`attention` is exactly
 *    the attempt's `reason`) → cleared, so the confirmation can go out;
 *  - there is another reason → kept, with "Reference X has since been
 *    recorded." appended once (the link reconciler's wording).
 * A held order (an amount, currency or mode mismatch) is never touched: it
 * stays held and flagged forever. Safe to repeat.
 */
export async function recoverFlaggedOrder(
  orderId: string,
  attemptReason: string | null,
  reference: string,
): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  await db.runTransaction(async (tx) => {
    const order = (await tx.get(ref)).data() as Partial<Order> | undefined;
    if (!order || order.heldAt || !order.attention) return;
    if (order.status !== "paid" && order.status !== "partially_refunded") return;
    if (attemptReason && order.attention === attemptReason) {
      tx.update(ref, { attention: null, attentionOpen: false, updatedAt: FieldValue.serverTimestamp() });
      return;
    }
    const note = `Reference ${reference} has since been recorded.`;
    if (order.attention.includes(note)) return;
    tx.update(ref, { attention: `${order.attention}\n${note}`, updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * The key a buy-page attempt was opened with is gone and 24 h have passed, so
 * Paystack can no longer be asked about it. Expire the order WITHOUT dropping
 * its `attention` note (a flag from the connection change stays, and a payment
 * that still lands is flagged for a refund by the reconciler). A held order is
 * never touched: money arrived for it.
 *  - "expired": it was pending and unheld, now expired;
 *  - "closed": it was already expired or failed;
 *  - "keep": anything else (held, paid, missing): leave it alone.
 */
export async function expireOrderKeepingFlag(orderId: string): Promise<"expired" | "closed" | "keep"> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const order = (await tx.get(ref)).data() as Partial<Order> | undefined;
    if (!order || order.source !== "product_link" || order.heldAt) return "keep" as const;
    if (order.status === "expired" || order.status === "failed") return "closed" as const;
    if (order.status !== "pending") return "keep" as const;
    tx.update(ref, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
    return "expired" as const;
  });
}

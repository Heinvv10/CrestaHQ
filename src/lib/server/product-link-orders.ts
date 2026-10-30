import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import type { Order } from "@/types/orders";

/**
 * The state changes of an express buy-link order (`source: "product_link"`)
 * that the generic order helpers in orders-service.ts don't cover. Part of
 * the same one write path for `orders/{id}`: routes and the reconciler never
 * write an order directly. Each is one transaction that re-reads the order
 * and changes it only from the state it expects.
 */

/**
 * Settle the Stripe session of an order written before it (express buy
 * links write the order first, so no provider session exists without a row).
 * With a session: record its id and mode so the reconciler can find the
 * order. Without one (the session call failed): the order can never be paid,
 * so it is marked `failed`. Only an order still `pending` with no session
 * changes; returns false otherwise.
 */
export async function attachCheckoutSession(
  orderId: string,
  session: { id: string; livemode: boolean } | null,
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const order = snap.data() as Partial<Order> | undefined;
    if (!order || order.status !== "pending" || order.stripeCheckoutSessionId !== "") {
      return false;
    }
    tx.update(
      ref,
      session
        ? {
            stripeCheckoutSessionId: session.id,
            livemode: session.livemode,
            updatedAt: FieldValue.serverTimestamp(),
          }
        : { status: "failed", updatedAt: FieldValue.serverTimestamp() },
    );
    return true;
  });
}

/**
 * Link an order to its buyer's contact, once: a no-op when the order already
 * has one, so a redelivery (or a racing one) never re-points it.
 */
export async function linkOrderContact(orderId: string, contactId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.contactId) return;
    tx.update(ref, { contactId, updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Money arrived for a pending order, but not the money it was opened for
 * (amount or currency). The order stays `pending` — never `paid`, so nothing
 * is delivered — with the payment recorded so a refund still finds it. The
 * caller flags it for the operator. Returns the order as stored, or null.
 */
export async function holdOrderPayment(input: {
  orderId: string;
  stripePaymentIntentId: string | null;
  buyerEmail: string | null;
  buyerName: string | null;
}): Promise<Order | null> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${input.orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
    if (order.status !== "pending") return order;
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (input.stripePaymentIntentId) patch.stripePaymentIntentId = input.stripePaymentIntentId;
    if (input.buyerEmail && !order.buyerEmail) patch.buyerEmail = input.buyerEmail;
    if (input.buyerName && !order.buyerName) patch.buyerName = input.buyerName;
    tx.update(ref, patch);
    return {
      ...order,
      stripePaymentIntentId: input.stripePaymentIntentId ?? order.stripePaymentIntentId,
      buyerEmail: order.buyerEmail ?? input.buyerEmail,
      buyerName: order.buyerName ?? input.buyerName,
    };
  });
}

/** A `product_link` order whose Stripe session expired unpaid. Pending only;
 *  returns whether it changed. */
export async function markOrderExpired(orderId: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const order = snap.data() as Partial<Order> | undefined;
    if (!order || order.status !== "pending" || order.source !== "product_link") return false;
    tx.update(ref, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}


/** True while the order is pending, linked to its Stripe session and not
 *  flagged: its checkout can still be paid as opened. */
export async function isOrderAwaitingPayment(orderId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`orders/${orderId}`).get();
  const order = snap.data() as Partial<Order> | undefined;
  return (
    !!order &&
    order.status === "pending" &&
    !!order.stripeCheckoutSessionId &&
    !order.attention
  );
}

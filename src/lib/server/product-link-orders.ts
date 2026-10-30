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

export type ProductLinkSettlement =
  /** This delivery moved the order pending → paid. */
  | { kind: "paid"; order: Order }
  /** Already paid (or paid then partly refunded): a redelivery. */
  | { kind: "already"; order: Order }
  /** Held: the money didn't match (now or on an earlier delivery). Never paid. */
  | { kind: "held"; order: Order }
  /** Expired, failed or refunded before this payment arrived. Never paid. */
  | { kind: "closed"; order: Order };

/**
 * The ONLY way a `product_link` order becomes `paid`: from `pending`, not
 * held, and only when `matches(order)` — the session collected exactly the
 * order's amount and currency, judged against the order as re-read in this
 * transaction. A mismatch HOLDS the order instead: it stays `pending` with
 * `heldAt` set and the payment intent and buyer recorded (so a refund still
 * finds it). A held order never becomes paid through any later event — not
 * a replay, not after a partial refund — and there is no release path in the
 * app: the operator refunds it (a manual "mark paid" may come later).
 */
export async function settleProductLinkPayment(input: {
  orderId: string;
  matches: (order: Order) => boolean;
  stripePaymentIntentId: string | null;
  buyerEmail: string | null;
  buyerName: string | null;
}): Promise<ProductLinkSettlement | null> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${input.orderId}`);
  return db.runTransaction(async (tx): Promise<ProductLinkSettlement | null> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
    if (order.heldAt) return { kind: "held", order };
    if (order.status === "paid" || order.status === "partially_refunded") {
      return { kind: "already", order };
    }
    if (order.status !== "pending") return { kind: "closed", order };

    const recorded = {
      stripePaymentIntentId: input.stripePaymentIntentId ?? order.stripePaymentIntentId,
      buyerEmail: order.buyerEmail ?? input.buyerEmail,
      buyerName: order.buyerName ?? input.buyerName,
    };
    const patch: Record<string, unknown> = {
      ...recorded,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!input.matches(order)) {
      tx.update(ref, { ...patch, heldAt: FieldValue.serverTimestamp() });
      return { kind: "held", order: { ...order, ...recorded, heldAt: new Date() } };
    }
    tx.update(ref, { ...patch, status: "paid", paidAt: FieldValue.serverTimestamp() });
    return { kind: "paid", order: { ...order, ...recorded, status: "paid" } };
  });
}

/**
 * Claims the order's one `order.paid` events (webhook, workflow, activity):
 * true for exactly one caller, once the order is paid and not held. Claimed
 * after the contact step, so the workflow sees the contact.
 */
export async function claimPaidEvents(orderId: string): Promise<Order | null> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
    if (order.heldAt || order.paidEventsFiredAt) return null;
    if (order.status !== "paid" && order.status !== "partially_refunded") return null;
    tx.update(ref, { paidEventsFiredAt: FieldValue.serverTimestamp() });
    return order;
  });
}

/** A `product_link` order whose Stripe session expired unpaid: pending,
 *  never held or flagged (a held order took money). Returns whether it changed. */
export async function markOrderExpired(orderId: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const order = snap.data() as Partial<Order> | undefined;
    if (!order || order.status !== "pending" || order.source !== "product_link") return false;
    if (order.heldAt || order.attention) return false;
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
    !order.heldAt &&
    !order.attention
  );
}

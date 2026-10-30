import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { orderFlagId } from "@/lib/server/billing-attention";
import { notifyFlag } from "@/lib/server/billing-attention-notify";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import {
  computeOrderSubtotalCents,
  isOrderTerminal,
  type Order,
  type OrderDeliverySnapshot,
  type OrderLineItem,
  type OrderSource,
} from "@/types/orders";
import type { ContactAttribution } from "@/types/contacts";
import type { WebhookEventType } from "@/types/webhooks";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Orders service — the ONE write path for `orders/{id}`.
 *
 * Per the UI-webhooks convention (2026-06-02), routes never write orders
 * directly: dashboard, public checkout, and the Stripe reconciler all come
 * through here so the webhook + workflow + activity side-effects can't drift.
 *
 * Tier-agnostic on purpose — nothing here knows whether the payment came via a
 * restricted key (Tier 1) or Stripe Connect (Tier 2).
 */

export class OrderError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OrderError";
    this.status = status;
  }
}

/** Wire shape sent to webhook subscribers. Explicit so a field added to the
 *  Firestore doc doesn't silently leak into subscribers' payloads. */
export interface OrderApiObject {
  id: string;
  status: Order["status"];
  currency: string;
  subtotal_cents: number;
  total_cents: number;
  refunded_cents: number;
  line_items: {
    product_id: string | null;
    name: string;
    unit_price_cents: number;
    quantity: number;
    is_bump: boolean;
  }[];
  contact_id: string | null;
  checkout_page_id: string | null;
  quote_id: string | null;
  event_id: string | null;
  purchase_id: string | null;
  source: OrderSource;
  livemode: boolean;
  buyer_email: string | null;
  buyer_name: string | null;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
}

export function serializeOrderForApi(order: Order): OrderApiObject {
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    subtotal_cents: order.subtotalCents,
    total_cents: order.totalCents,
    refunded_cents: order.refundedCents,
    line_items: order.lineItems.map((li) => ({
      product_id: li.productId,
      name: li.name,
      unit_price_cents: li.unitPriceCents,
      quantity: li.quantity,
      is_bump: li.isBump,
    })),
    contact_id: order.contactId,
    checkout_page_id: order.checkoutPageId,
    quote_id: order.quoteId ?? null,
    event_id: order.eventId ?? null,
    purchase_id: order.purchaseId ?? null,
    source: order.source,
    livemode: order.livemode,
    buyer_email: order.buyerEmail,
    buyer_name: order.buyerName,
    stripe_checkout_session_id: order.stripeCheckoutSessionId,
    stripe_payment_intent_id: order.stripePaymentIntentId,
  };
}

/**
 * Create a `pending` order at checkout-session-creation time.
 *
 * Written BEFORE the buyer reaches Stripe so the webhook always has a row to
 * reconcile against — a payment that arrives with no order row is
 * unattributable, which is far worse than an abandoned pending row.
 */
export async function createPendingOrder(input: {
  agencyId: string;
  subAccountId: string;
  contactId: string | null;
  checkoutPageId: string | null;
  quoteId?: string | null;
  eventId?: string | null;
  communityGroupId?: string | null;
  purchaseId?: string | null;
  source: OrderSource;
  currency: string;
  lineItems: OrderLineItem[];
  stripeCheckoutSessionId: string;
  livemode: boolean;
  buyerEmail: string | null;
  buyerName: string | null;
  attribution: ContactAttribution | null;
  productLinkProductId?: string | null;
  deliveries?: OrderDeliverySnapshot[];
  thanksTokenHash?: string;
}): Promise<string> {
  if (input.lineItems.length === 0) {
    throw new OrderError("An order needs at least one line item.");
  }
  const subtotalCents = computeOrderSubtotalCents(input.lineItems);
  if (subtotalCents <= 0) {
    throw new OrderError("Order total must be greater than zero.");
  }

  const ref = getAdminDb().collection("orders").doc();
  await ref.set({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    contactId: input.contactId,
    checkoutPageId: input.checkoutPageId,
    quoteId: input.quoteId ?? null,
    eventId: input.eventId ?? null,
    communityGroupId: input.communityGroupId ?? null,
    purchaseId: input.purchaseId ?? null,
    source: input.source,
    status: "pending",
    currency: input.currency.toLowerCase(),
    lineItems: input.lineItems,
    subtotalCents,
    // v1 has no tax/shipping/discounts, so total === subtotal. Kept as its own
    // field so adding them later doesn't require rewriting historical orders.
    totalCents: subtotalCents,
    refundedCents: 0,
    stripeCheckoutSessionId: input.stripeCheckoutSessionId,
    stripePaymentIntentId: null,
    livemode: input.livemode,
    buyerEmail: input.buyerEmail,
    buyerName: input.buyerName,
    attribution: input.attribution,
    ...(input.productLinkProductId
      ? { productLinkProductId: input.productLinkProductId }
      : {}),
    ...(input.deliveries?.length ? { deliveries: input.deliveries } : {}),
    ...(input.thanksTokenHash ? { thanksTokenHash: input.thanksTokenHash } : {}),
    createdAt: FieldValue.serverTimestamp(),
    paidAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

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

/** Look an order up by its Stripe Checkout Session id — the reconciler's
 *  idempotency key. Equality-only query, no composite index needed. */
export async function findOrderByCheckoutSession(
  sessionId: string,
): Promise<Order | null> {
  const snap = await getAdminDb()
    .collection("orders")
    .where("stripeCheckoutSessionId", "==", sessionId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Order, "id">) };
}

/** Look an order up by PaymentIntent — refunds and disputes reference that,
 *  not the session. */
export async function findOrderByPaymentIntent(
  paymentIntentId: string,
): Promise<Order | null> {
  const snap = await getAdminDb()
    .collection("orders")
    .where("stripePaymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Order, "id">) };
}

/**
 * Mark an order paid. IDEMPOTENT — Stripe delivers
 * `checkout.session.completed` more than once in normal operation, and a
 * double-fire here would mean two `order.paid` webhooks, two workflow
 * enrollments, and two activity rows for one payment.
 *
 * Returns false when the order was already paid (or terminal), so the caller
 * can skip the side-effects rather than replaying them.
 */
export async function markOrderPaid(input: {
  orderId: string;
  stripePaymentIntentId: string | null;
  buyerEmail?: string | null;
  buyerName?: string | null;
}): Promise<{ changed: boolean; order: Order | null }> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${input.orderId}`);

  // Transaction so two concurrent webhook deliveries can't both "win".
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed: false, order: null as Order | null };
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };

    if (order.status === "paid" || isOrderTerminal(order.status)) {
      return { changed: false, order };
    }

    const patch: Record<string, unknown> = {
      status: "paid",
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (input.stripePaymentIntentId) {
      patch.stripePaymentIntentId = input.stripePaymentIntentId;
    }
    // Stripe knows the buyer's real email; the pre-checkout form may not have.
    if (input.buyerEmail && !order.buyerEmail) patch.buyerEmail = input.buyerEmail;
    if (input.buyerName && !order.buyerName) patch.buyerName = input.buyerName;

    tx.update(ref, patch);
    return {
      changed: true,
      order: {
        ...order,
        status: "paid" as const,
        stripePaymentIntentId:
          input.stripePaymentIntentId ?? order.stripePaymentIntentId,
        buyerEmail: order.buyerEmail ?? input.buyerEmail ?? null,
        buyerName: order.buyerName ?? input.buyerName ?? null,
      },
    };
  });

  return result;
}

/**
 * Flag a paid order for the operator: the money arrived but what it paid for
 * could not be settled with it. Overwrites the note on a replay, so a
 * redelivered event never stacks duplicates — and never reopens a flag an
 * admin already resolved (the flag is the order + its source, not the note's
 * wording). The sub-account's admins are emailed once per flag.
 */
export async function flagOrderAttention(order: Order, note: string): Promise<void> {
  const ref = getAdminDb().doc(`orders/${order.id}`);
  // Not a transaction: the only concurrent writer is an admin's resolve, and
  // losing that race just leaves the flag open to be resolved again.
  const resolved = !!(await ref.get()).data()?.attentionResolvedAt;
  await ref.update({
    attention: note,
    ...(resolved ? {} : { attentionOpen: true }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await notifyFlag({
    flagId: orderFlagId(order.id, order.source),
    audience: "subAccountAdmins",
    agencyId: order.agencyId,
    subAccountId: order.subAccountId,
    reason: note,
    amountCents: order.totalCents,
    currency: order.currency,
    reference: order.stripePaymentIntentId ?? order.stripeCheckoutSessionId,
  });
}

/**
 * Record a refund against an order. Also idempotent — the same
 * `charge.refunded` event can arrive twice, and refunds are cumulative so a
 * replay would otherwise double-count.
 */
export async function recordOrderRefund(input: {
  orderId: string;
  /** TOTAL refunded on the charge so far, per Stripe — not the delta. */
  refundedCentsTotal: number;
}): Promise<{ changed: boolean; order: Order | null }> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${input.orderId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed: false, order: null as Order | null };
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };

    // Stripe sends the running total, so an equal value is a replay.
    if (input.refundedCentsTotal <= order.refundedCents) {
      return { changed: false, order };
    }

    const status =
      input.refundedCentsTotal >= order.totalCents
        ? ("refunded" as const)
        : ("partially_refunded" as const);

    tx.update(ref, {
      refundedCents: input.refundedCentsTotal,
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      changed: true,
      order: { ...order, refundedCents: input.refundedCentsTotal, status },
    };
  });
}

/**
 * Fire the downstream effects of an order state change. Fire-and-forget: a
 * failing workflow or webhook must never break the reconciler, or Stripe would
 * retry a payment we already recorded.
 */
export function emitOrderEvents(opts: {
  order: Order;
  type: WebhookEventType;
  activity: { type: "order_paid" | "order_refunded"; content: string } | null;
}): void {
  runAfterResponse(async () => {
    const wire = serializeOrderForApi(opts.order);

    try {
      await emitWebhookEvent({
        subAccountId: opts.order.subAccountId,
        agencyId: opts.order.agencyId,
        // A test-mode Stripe key produces test-mode events, so live-only
        // subscribers aren't woken by play money.
        mode: opts.order.livemode ? "live" : "test",
        type: opts.type,
        payload: { order: wire },
      });
    } catch (err) {
      console.warn("[orders-service] webhook emit failed", err);
    }

    // Workflows + activity need a contact. An unreconciled order (no contact
    // yet) still emits its webhook above — it just can't enroll anyone.
    if (!opts.order.contactId) return;

    if (opts.type === "order.paid") {
      try {
        await fireWorkflowTrigger({
          subAccountId: opts.order.subAccountId,
          agencyId: opts.order.agencyId,
          type: "order.paid",
          contactId: opts.order.contactId,
          context: { orderId: opts.order.id, totalCents: opts.order.totalCents },
        });
      } catch (err) {
        console.warn("[orders-service] workflow trigger failed", err);
      }
    }

    if (opts.activity) {
      try {
        await getAdminDb()
          .collection("contacts")
          .doc(opts.order.contactId)
          .collection("activities")
          .add({
            type: opts.activity.type,
            content: opts.activity.content,
            createdBy: "system",
            meta: { orderId: opts.order.id },
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (err) {
        console.warn("[orders-service] activity write failed", err);
      }
    }
  });
}

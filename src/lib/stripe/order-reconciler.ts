import "server-only";

import type Stripe from "stripe";

import { formatCurrency } from "@/lib/format";
import {
  emitOrderEvents,
  findOrderByCheckoutSession,
  findOrderByPaymentIntent,
  markOrderPaid,
  recordOrderRefund,
} from "@/lib/server/orders-service";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import { markPurchasePaidServerSide } from "@/lib/server/community-purchase-service";
import type { Order } from "@/types/orders";

/**
 * The shared Stripe → order reconciler.
 *
 * TIER-AGNOSTIC BY DESIGN. Two routes feed it and it never learns which:
 *
 *   /api/webhooks/stripe/sa/[subAccountId]  → Tier 1 (per-account endpoint,
 *                                             per-account signing secret)
 *   /api/webhooks/stripe/connect            → Tier 2 (one platform endpoint,
 *                                             sub-account from event.account)
 *
 * Only the routes differ — signature verification and sub-account resolution.
 * All order logic lives here, so adding Connect later is a new route file and
 * nothing else. Keep it that way: do not put order logic in a route.
 *
 * Also NOT the same as `lib/stripe/webhooks.ts`, which handles the AGENCY's own
 * Stripe (founders checkout, Client Billing subscriptions). Different account,
 * different secret, different collection.
 *
 * Never throws — the caller always 200s to Stripe. A thrown error would make
 * Stripe retry a payment we may have already recorded, and repeated failures
 * eventually disable the endpoint on the client's account.
 */

/** Audit stamp for access granted by a confirmed Stripe payment rather than
 *  by a staff admin clicking "mark paid". Written to `purchase.grantedByUid`. */
const STRIPE_GRANTOR = "system:stripe";

export interface ReconcileResult {
  handled: boolean;
  /** Human-readable outcome, surfaced in logs only. */
  detail: string;
}

export async function reconcileStripeEvent(input: {
  subAccountId: string;
  event: Stripe.Event;
}): Promise<ReconcileResult> {
  const { subAccountId, event } = input;

  try {
    switch (event.type) {
      case "checkout.session.completed":
        return await handleCheckoutCompleted(subAccountId, event);
      case "charge.refunded":
        return await handleChargeRefunded(subAccountId, event);
      case "charge.dispute.created":
        return await handleDisputeCreated(subAccountId, event);
      default:
        return { handled: false, detail: `ignored ${event.type}` };
    }
  } catch (err) {
    console.error(
      `[order-reconciler] ${event.type} failed sa=${subAccountId} event=${event.id}`,
      err,
    );
    return { handled: false, detail: "error" };
  }
}

async function handleCheckoutCompleted(
  subAccountId: string,
  event: Stripe.Event,
): Promise<ReconcileResult> {
  const session = event.data.object as Stripe.Checkout.Session;

  // Unpaid sessions do exist (async payment methods). Only money counts.
  if (session.payment_status !== "paid") {
    return { handled: false, detail: `payment_status=${session.payment_status}` };
  }

  const order = await findOrderByCheckoutSession(session.id);
  if (!order) {
    // Someone's Stripe account sent us a session we never created. Log loudly:
    // in Tier 1 the operator controls the endpoint and could point another
    // integration's events at us.
    console.warn(
      `[order-reconciler] no order for session=${session.id} sa=${subAccountId}`,
    );
    return { handled: false, detail: "no matching order" };
  }

  // Cross-tenant guard. The route already proved the caller holds this
  // sub-account's signing secret; this catches a session id colliding with
  // another tenant's order rather than trusting the lookup blindly.
  if (order.subAccountId !== subAccountId) {
    console.error(
      `[order-reconciler] tenancy mismatch order=${order.id} expected=${subAccountId} got=${order.subAccountId}`,
    );
    return { handled: false, detail: "tenancy mismatch" };
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  const { changed, order: updated } = await markOrderPaid({
    orderId: order.id,
    stripePaymentIntentId: paymentIntentId,
    buyerEmail: session.customer_details?.email ?? null,
    buyerName: session.customer_details?.name ?? null,
  });

  // The idempotency point: a redelivered event finds the order already paid
  // and stops here, so no duplicate webhook / workflow / activity.
  if (!changed || !updated) {
    return { handled: true, detail: "already paid (idempotent no-op)" };
  }

  emitOrderEvents({
    order: updated,
    type: "order.paid",
    activity: {
      type: "order_paid",
      content: `Paid ${formatCurrency(
        updated.totalCents / 100,
        updated.currency.toUpperCase(),
      )} by card.`,
    },
  });

  // Source-specific follow-through (Phase B). The order is already paid and
  // its events already fired — anything below is an ADDITIONAL surface being
  // brought in line, and a failure here must not undo the payment record.
  await applySourceEffects(updated);

  return { handled: true, detail: `order ${updated.id} paid` };
}

/**
 * Bring the originating surface in line with a paid order.
 *
 * Phase B adopters hang off here — one branch per `order.source`. Deliberately
 * a post-step rather than something baked into `markOrderPaid`: the order is
 * the record of the money, and it must stand on its own even if the surface it
 * came from has since been deleted or is in an unexpected state.
 *
 * Never throws. The payment already happened; the worst case is an invoice
 * that still reads "sent" and needs the operator's manual Mark as paid.
 */
async function applySourceEffects(order: Order): Promise<void> {
  try {
    if (order.source === "quote" && order.quoteId) {
      // Routes through the SAME service the operator's "Mark as paid" button
      // uses, so the activity row, `quote.paid` workflow trigger, outbound
      // webhook, and auto review-request all fire exactly once and identically.
      // Its own idempotency guard makes a replayed Stripe event a no-op.
      const res = await markQuotePaidServerSide({
        quoteId: order.quoteId,
        expectSubAccountId: order.subAccountId,
      });
      if (!res.ok && res.code !== "already_paid") {
        console.warn(
          `[order-reconciler] invoice ${order.quoteId} not marked paid: ${res.code} — ${res.message}`,
        );
      }
    }

    if (order.source === "booking_deposit" && order.eventId) {
      // Same service the operator's "Mark as paid" button uses: rotates the
      // public token, clears the hold, schedules reminders, and sends the ICS
      // confirmation. Its own awaiting_payment guard makes a replayed Stripe
      // event a no-op, so the visitor never gets two confirmations.
      const res = await markBookingPaidServerSide({
        eventId: order.eventId,
        expectSubAccountId: order.subAccountId,
        paidByUid: null,
      });
      if (!res.ok && res.code !== "bad_status") {
        console.warn(
          `[order-reconciler] booking ${order.eventId} not confirmed: ${res.code} — ${res.message}`,
        );
      }
    }
    if (
      order.source === "community" &&
      order.communityGroupId &&
      order.purchaseId
    ) {
      // Same service a staff admin's manual "mark paid" uses: flips the
      // purchase, grants group membership or unlocks the course, and fires
      // community.member.joined / community.purchase.paid. Already idempotent
      // (returns early when the purchase is paid), so a replay is a no-op.
      await markPurchasePaidServerSide({
        subAccountId: order.subAccountId,
        groupId: order.communityGroupId,
        purchaseId: order.purchaseId,
        grantedByUid: STRIPE_GRANTOR,
      });
    }
  } catch (err) {
    console.error(
      `[order-reconciler] source effects failed order=${order.id} source=${order.source}`,
      err,
    );
  }
}

async function handleChargeRefunded(
  subAccountId: string,
  event: Stripe.Event,
): Promise<ReconcileResult> {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);
  if (!paymentIntentId) {
    return { handled: false, detail: "charge has no payment_intent" };
  }

  const order = await findOrderByPaymentIntent(paymentIntentId);
  if (!order) return { handled: false, detail: "no matching order" };
  if (order.subAccountId !== subAccountId) {
    console.error(
      `[order-reconciler] tenancy mismatch on refund order=${order.id} expected=${subAccountId}`,
    );
    return { handled: false, detail: "tenancy mismatch" };
  }

  // `amount_refunded` is the running total on the charge, which is exactly
  // what the service wants — it compares against the stored total to detect
  // replays, so partial refunds accumulate correctly.
  const { changed, order: updated } = await recordOrderRefund({
    orderId: order.id,
    refundedCentsTotal: charge.amount_refunded,
  });
  if (!changed || !updated) {
    return { handled: true, detail: "refund already recorded (idempotent no-op)" };
  }

  emitOrderEvents({
    order: updated,
    type: "order.refunded",
    activity: {
      type: "order_refunded",
      content: `Refunded ${formatCurrency(
        updated.refundedCents / 100,
        updated.currency.toUpperCase(),
      )}${updated.status === "partially_refunded" ? " (partial)" : ""}.`,
    },
  });

  return { handled: true, detail: `order ${updated.id} ${updated.status}` };
}

/**
 * Disputes are RECORDED, not acted on. Under direct charges the client is
 * merchant of record — the dispute is theirs to fight in their own Stripe
 * dashboard, and we have no standing to respond. (Unrelated to the agency's
 * own chargeback defense in `lib/stripe/dispute.ts`, which protects LeadStack
 * license sales.)
 */
async function handleDisputeCreated(
  subAccountId: string,
  event: Stripe.Event,
): Promise<ReconcileResult> {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : (dispute.payment_intent?.id ?? null);
  if (!paymentIntentId) return { handled: false, detail: "dispute has no payment_intent" };

  const order = await findOrderByPaymentIntent(paymentIntentId);
  if (!order || order.subAccountId !== subAccountId) {
    return { handled: false, detail: "no matching order" };
  }

  console.warn(
    `[order-reconciler] dispute opened order=${order.id} sa=${subAccountId} amount=${dispute.amount}`,
  );
  return { handled: true, detail: `dispute logged for order ${order.id}` };
}

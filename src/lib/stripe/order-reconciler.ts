import "server-only";

import type Stripe from "stripe";

import { formatCurrency } from "@/lib/format";
import {
  emitOrderEvents,
  findOrderByCheckoutSession,
  findOrderByPaymentIntent,
  flagOrderAttention,
  markOrderPaid,
  recordOrderRefund,
} from "@/lib/server/orders-service";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import { markPurchasePaidServerSide } from "@/lib/server/community-purchase-service";
import {
  centsToStripeAmount,
  stripeAmountToCents,
  stripeCanChargeCurrency,
} from "@/lib/stripe/amount";
import { getAdminDb } from "@/lib/firebase/admin";
import { eventTokenSecretConfigured } from "@/lib/booking/event-token";
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
 * Throws only on a genuine processing failure (e.g. Firestore unavailable),
 * which the route turns into a 5xx so Stripe redelivers. Everything else —
 * ignored types, foreign sessions, replays — resolves normally and gets a 200.
 * A redelivery is safe: every step recognises its own earlier success.
 *
 * Deterministic outcomes never throw, or a redelivery would fail the same way
 * for days: a missing order / invoice / booking / purchase, a wrong tenant, a
 * status that cannot take the payment, a changed amount — each resolves, and
 * the ones where money arrived for nothing are flagged on `order.attention`.
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
      // Delayed methods (SEPA, ACH, …) complete the session unpaid and settle
      // later with this event, carrying the same session, now paid.
      case "checkout.session.async_payment_succeeded":
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
    throw err;
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

  if (!updated) return { handled: true, detail: "order no longer exists" };

  // The idempotency point for the order's own events: a redelivered event
  // finds the order already paid, so no duplicate webhook / workflow / activity.
  if (changed) {
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
  } else if (updated.status !== "paid" && updated.status !== "partially_refunded") {
    return { handled: true, detail: `order ${updated.id} is ${updated.status}` };
  }

  // Source-specific follow-through (Phase B). Runs on a redelivery too: an
  // earlier delivery may have paid the order and then failed here, and
  // Stripe's retry is what finishes the job. Each branch recognises its own
  // earlier success, so a plain replay changes nothing.
  const problem = await applySourceEffects(updated, session, changed ? null : updated.paidAt);
  if (problem) {
    console.warn(`[order-reconciler] order ${updated.id} needs attention: ${problem}`);
    await flagOrderAttention(updated, problem).catch((err: unknown) => {
      // NOT_FOUND = the order was deleted after we paid it; a retry cannot
      // help, so log it rather than loop 5xx. Anything else is transient.
      if ((err as { code?: unknown })?.code !== 5) throw err;
      console.error(`[order-reconciler] order ${updated.id} vanished before its flag: ${problem}`);
    });
  }

  return {
    handled: true,
    detail: changed ? `order ${updated.id} paid` : "already paid (idempotent no-op)",
  };
}

const PAID_ANOTHER_WAY =
  "Paid, but the invoice was already paid (another payment, or marked paid by hand) — a refund may be owed.";
const INVOICE_CHANGED =
  "Paid, but the invoice total or currency changed after checkout opened, so it was not marked paid. Check the amount and mark it by hand.";

/**
 * Bring the originating surface in line with a paid order.
 *
 * Phase B adopters hang off here — one branch per `order.source`. Deliberately
 * a post-step rather than something baked into `markOrderPaid`: the order is
 * the record of the money, and it must stand on its own even if the surface it
 * came from has since been deleted or is in an unexpected state.
 *
 * Returns why the surface could not be settled with this payment (the order
 * is flagged for the operator), or null. Throws on a transient failure so the
 * route answers 5xx and Stripe redelivers.
 */
/** Firestore Timestamp / Date → ms; null when absent. */
function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number } | null;
  return typeof ts?.toMillis === "function" ? ts.toMillis() : null;
}

async function applySourceEffects(
  order: Order,
  session: Stripe.Checkout.Session,
  /** When the order was paid, on a redelivery; null when THIS delivery paid it. */
  orderPaidAt: unknown,
): Promise<string | null> {
  // An "already paid" surface with no payer recorded is this same payment
  // only if it was marked paid AFTER the order was: settled before payers
  // were recorded, or marked by hand while Stripe was retrying. Marked paid
  // before the order was paid means a second payment. Decided from stored
  // times, not from which delivery this is, so a retry after a failed flag
  // write reaches the same answer. Unknown times flag — the safe side.
  const unrecordedIsOurs = (payer: unknown, surfacePaidAt: unknown) => {
    const [surface, ours] = [millis(surfacePaidAt), millis(orderPaidAt)];
    return payer == null && surface !== null && ours !== null && surface >= ours;
  };

  if (order.source === "quote" && order.quoteId) {
    // The invoice is settled only for the amount this session collected,
    // which must be the amount the order was opened for. Adaptive Pricing
    // sessions created before 2025-03-31 report the buyer's converted amount
    // on the session and the integration amount under `currency_conversion`;
    // newer ones keep the integration amount on the session itself.
    const paidAmount = session.currency_conversion?.amount_total ?? session.amount_total;
    const paidCurrency = (session.currency_conversion?.source_currency ?? session.currency ?? "").toLowerCase();
    if (
      paidCurrency !== order.currency.toLowerCase() ||
      !stripeCanChargeCurrency(paidCurrency) ||
      paidAmount !== centsToStripeAmount(order.totalCents, order.currency)
    ) {
      return `Paid ${paidAmount ?? "?"} ${paidCurrency.toUpperCase()} (Stripe units), which differs from this order — the invoice was not marked paid. Check it by hand.`;
    }
    // Routes through the SAME service the operator's "Mark as paid" button
    // uses, so the activity row, `quote.paid` workflow trigger, outbound
    // webhook, and auto review-request fire identically — at most once, and
    // only for the caller that wins its compare-and-set (a crash after the
    // commit skips them). The expected total is re-checked inside that
    // compare-and-set: the invoice may have been edited since checkout opened.
    const res = await markQuotePaidServerSide({
      quoteId: order.quoteId,
      expectSubAccountId: order.subAccountId,
      paidVia: { rail: "stripe_order", orderId: order.id },
      expectTotalCents: order.totalCents,
      expectCurrency: order.currency,
    });
    if (res.ok) return null;
    if (res.code === "already_paid") {
      // Our own earlier success (a redelivery) is not a second payment.
      return (res.paidVia?.rail === "stripe_order" && res.paidVia.orderId === order.id) ||
        unrecordedIsOurs(res.paidVia, res.paidAt)
        ? null
        : PAID_ANOTHER_WAY;
    }
    if (res.code === "amount_changed") return INVOICE_CHANGED;
    return `Paid, but the invoice could not be marked paid: ${res.message}`;
  }

  if (order.source === "booking_deposit" && order.eventId) {
    // Confirming rotates the booking's signed link. Without the secret that
    // throws on every delivery — a config fault a retry cannot fix.
    if (!eventTokenSecretConfigured()) {
      console.error("[order-reconciler] AUTOMATIONS_TOKEN_SECRET missing — cannot confirm a paid booking");
      return "Paid, but the booking could not be confirmed (server misconfigured) — confirm it by hand.";
    }
    // Same service the operator's "Mark as paid" button uses: rotates the
    // public token, clears the hold, schedules reminders, and sends the ICS
    // confirmation. Its own awaiting_payment guard makes a replayed Stripe
    // event a no-op, so the visitor never gets two confirmations.
    const res = await markBookingPaidServerSide({
      eventId: order.eventId,
      expectSubAccountId: order.subAccountId,
      paidByUid: null,
      paidOrderId: order.id,
    });
    if (res.ok) return null;
    if (res.code === "write_failed") {
      throw new Error(`booking ${order.eventId} confirm write failed`);
    }
    if (res.code === "bad_status") {
      return res.paidOrderId === order.id ||
        (res.status === "scheduled" && unrecordedIsOurs(res.paidOrderId, res.paidAt))
        ? null
        : `Paid, but the booking was no longer awaiting payment (${res.status ?? "unknown"}) — confirm it by hand or refund the deposit.`;
    }
    return `Paid, but the booking could not be confirmed: ${res.message}`;
  }

  if (
    order.source === "community" &&
    order.communityGroupId &&
    order.purchaseId
  ) {
    // A deleted purchase is permanent — flag it rather than retry for days.
    const purchase = await getAdminDb()
      .doc(`subAccounts/${order.subAccountId}/communityGroups/${order.communityGroupId}/purchases/${order.purchaseId}`)
      .get();
    const group = await getAdminDb()
      .doc(`subAccounts/${order.subAccountId}/communityGroups/${order.communityGroupId}`)
      .get();
    if (!purchase.exists || !group.exists) {
      return "Paid, but the community purchase or its group no longer exists — grant access by hand or refund.";
    }
    // Same service a staff admin's manual "mark paid" uses: grants group
    // membership or unlocks the course, flips the purchase, and fires
    // community.member.joined / community.purchase.paid. Idempotent (returns
    // early when the purchase is paid), so a replay is a no-op; a transient
    // failure throws and the redelivery finishes it.
    const res = await markPurchasePaidServerSide({
      subAccountId: order.subAccountId,
      groupId: order.communityGroupId,
      purchaseId: order.purchaseId,
      grantedByUid: STRIPE_GRANTOR,
      paidOrderId: order.id,
    });
    const prior = res.alreadyPaid;
    if (prior && prior.paidOrderId !== order.id && !unrecordedIsOurs(prior.paidOrderId, prior.paidAt)) {
      return "Paid, but the community purchase was already paid (another payment, or marked paid by hand) — a refund may be owed.";
    }
  }
  return null;
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
    // Stripe's amount is in whole units for zero-decimal currencies.
    refundedCentsTotal: stripeAmountToCents(charge.amount_refunded, order.currency),
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

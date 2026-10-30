import "server-only";

import type Stripe from "stripe";

import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { centsToStripeAmount, stripeCanChargeCurrency } from "@/lib/stripe/amount";
import { formatCurrency } from "@/lib/format";
import {
  emitOrderEvents,
  findOrderByCheckoutSession,
  flagOrderAttention,
} from "@/lib/server/orders-service";
import {
  claimContactLink,
  claimPaidEvents,
  linkOrderContact,
  releaseContactLink,
  markOrderExpired,
  settleProductLinkPayment,
} from "@/lib/server/product-link-orders";
import { sendOrderConfirmationAfterResponse } from "@/lib/server/order-confirmation-service";
import type { Order } from "@/types/orders";

/**
 * The express buy-link (`source: "product_link"`) steps of the Stripe order
 * reconciler (order-reconciler.ts), kept here so that file stays one switch
 * over sources. Same contract: deterministic outcomes resolve, transient
 * failures throw so the route answers 5xx and Stripe redelivers.
 */

/** Buyer-typed on Stripe's page: trimmed and capped before it is stored. */
export function sessionBuyer(session: Stripe.Checkout.Session): {
  email: string | null;
  name: string | null;
  phone: string | null;
} {
  const d = session.customer_details;
  return {
    email: d?.email?.trim().toLowerCase().slice(0, 254) || null,
    name: (d?.name ?? d?.individual_name)?.trim().slice(0, 200) || null,
    phone: d?.phone?.trim().slice(0, 40) || null,
  };
}

/**
 * Whether the session collected exactly what the order was opened for.
 * Adaptive Pricing sessions created before 2025-03-31 report the buyer's
 * converted amount on the session and the integration amount under
 * `currency_conversion`; newer ones keep the integration amount on the
 * session itself.
 */
export function sessionAmountCheck(
  order: Pick<Order, "currency" | "totalCents">,
  session: Stripe.Checkout.Session,
): { ok: boolean; paidAmount: number | null; paidCurrency: string } {
  const paidAmount = session.currency_conversion?.amount_total ?? session.amount_total ?? null;
  const paidCurrency = (session.currency_conversion?.source_currency ?? session.currency ?? "").toLowerCase();
  const ok =
    paidCurrency === order.currency.toLowerCase() &&
    stripeCanChargeCurrency(paidCurrency) &&
    paidAmount === centsToStripeAmount(order.totalCents, order.currency);
  return { ok, paidAmount, paidCurrency };
}

async function flag(order: Order, note: string): Promise<void> {
  console.warn(`[order-reconciler] order ${order.id} needs attention: ${note}`);
  await flagOrderAttention(order, note).catch((err: unknown) => {
    // NOT_FOUND = deleted under us; a retry cannot help.
    if ((err as { code?: unknown })?.code !== 5) throw err;
    console.error(`[order-reconciler] order ${order.id} vanished before its flag`);
  });
}

/**
 * A paid session for a `product_link` order. Replaces the generic
 * markOrderPaid path for this source:
 *
 *  1. `settleProductLinkPayment` — the only pending → paid transition, and
 *     only on a matching amount and currency; a mismatch holds the order
 *     (flagged, never paid). Money for an order already expired, failed or
 *     refunded (not this same payment replayed) is flagged, never dropped.
 *  2. Contact — a paid order with no contact finds or creates the buyer's
 *     contact from Stripe's email (email-first, the same rule as forms) and
 *     is linked once. Doesn't block paid: the order is already paid; a
 *     failure throws (5xx) so Stripe's redelivery retries the link.
 *     The step is claimed (`claimContactLink`, 60 s lease) so concurrent
 *     deliveries create one contact; the others answer 5xx and retry.
 *  3. `order.paid` events — claimed once (`paidEventsFiredAt`), after the
 *     contact step so the workflow sees the contact. AT MOST ONCE: a failed
 *     emit after the claim is not retried. A persistent contact failure
 *     delays them until a delivery links it, and an order fully refunded
 *     before that never fires them.
 *  4. The order confirmation email (claimed once, after the response).
 */
export async function handleProductLinkCompleted(
  order: Order,
  session: Stripe.Checkout.Session,
  paymentIntentId: string | null,
): Promise<{ handled: boolean; detail: string }> {
  const buyer = sessionBuyer(session);
  const amount = sessionAmountCheck(order, session);
  const settled = await settleProductLinkPayment({
    orderId: order.id,
    matches: (stored) => sessionAmountCheck(stored, session).ok,
    stripePaymentIntentId: paymentIntentId,
    buyerEmail: buyer.email,
    buyerName: buyer.name,
  });
  if (!settled) return { handled: true, detail: "order no longer exists" };

  if (settled.kind === "held") {
    await flag(
      settled.order,
      `Paid ${amount.paidAmount ?? "?"} ${amount.paidCurrency.toUpperCase()} (Stripe units), which differs from this order — it was not marked paid and nothing was delivered. Refund it, or settle it by hand.`,
    );
    return { handled: true, detail: `order ${order.id} held: amount mismatch` };
  }
  if (settled.kind === "closed") {
    // Flag once: when this delivery recorded the money, or the money differs
    // from what the order already records. A replay of the recorded payment
    // (its own, or one flagged earlier) is not flagged again.
    const known = !!paymentIntentId && settled.order.stripePaymentIntentId === paymentIntentId;
    if (settled.firstPayment || !known) {
      await flag(
        settled.order,
        `Paid, but this order was already ${settled.order.status} — nothing was delivered. Refund the payment, or settle it by hand.`,
      );
    }
    return { handled: true, detail: `order ${order.id} is ${settled.order.status}` };
  }

  await finishPaidProductLinkOrder(settled.order, buyer);

  return {
    handled: true,
    detail: settled.kind === "paid" ? `order ${settled.order.id} paid` : "already paid (idempotent no-op)",
  };
}

/**
 * Steps 2-4 of a paid `product_link` order, shared by every rail (Stripe here,
 * Paystack in `paystack/product-order-reconciler.ts`) so there is exactly one
 * contact path, one `order.paid` claim and one confirmation email. Each step
 * is claimed or compare-and-set, so a redelivery repeats none of them.
 */
export async function finishPaidProductLinkOrder(
  order: Order,
  buyer: { email: string | null; name: string | null; phone: string | null },
): Promise<void> {
  let paid = order;
  const email = paid.buyerEmail ?? buyer.email;
  if (!paid.contactId && email) {
    // One delivery at a time, so concurrent deliveries create one contact.
    const claim = await claimContactLink(paid.id);
    if (claim.state === "busy") {
      throw new Error(`contact step for order ${paid.id} is held by another delivery`);
    }
    if (claim.state === "claimed") {
      try {
        const res = await reconcileContactFromCapture({
          agencyId: paid.agencyId,
          subAccountId: paid.subAccountId,
          existingContactId: null,
          pageUrl: null,
          source: "checkout",
          matchStrategy: "email-first",
          capture: { name: paid.buyerName ?? buyer.name, email, phone: buyer.phone },
        });
        if (res?.contactId) await linkOrderContact(paid.id, res.contactId);
      } catch (err) {
        await releaseContactLink(paid.id, claim.token).catch((releaseErr: unknown) =>
          console.error(
            `[order-reconciler] contact claim release failed order=${paid.id}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
          ),
        );
        throw err;
      }
    }
  }

  const claimed = await claimPaidEvents(paid.id);
  if (claimed) {
    paid = claimed;
    emitOrderEvents({
      order: claimed,
      type: "order.paid",
      activity: {
        type: "order_paid",
        content: `Paid ${formatCurrency(claimed.totalCents / 100, claimed.currency.toUpperCase())} by card.`,
      },
    });
  }
  sendOrderConfirmationAfterResponse(paid.id);
}

/** `checkout.session.expired`: the buyer never paid; close a pending buy-link order. */
export async function handleCheckoutExpired(
  subAccountId: string,
  session: Stripe.Checkout.Session,
): Promise<{ handled: boolean; detail: string }> {
  const order = await findOrderByCheckoutSession(session.id);
  if (!order) return { handled: false, detail: "no matching order" };
  if (order.subAccountId !== subAccountId) {
    console.error(
      `[order-reconciler] tenancy mismatch on expiry order=${order.id} expected=${subAccountId}`,
    );
    return { handled: false, detail: "tenancy mismatch" };
  }
  // markOrderExpired changes only a pending product_link order.
  const changed = await markOrderExpired(order.id);
  return changed
    ? { handled: true, detail: `order ${order.id} expired` }
    : { handled: false, detail: `order ${order.id} (${order.source}, ${order.status}) left as is` };
}

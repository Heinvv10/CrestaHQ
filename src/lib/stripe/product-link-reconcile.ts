import "server-only";

import type Stripe from "stripe";

import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { centsToStripeAmount, stripeCanChargeCurrency } from "@/lib/stripe/amount";
import { findOrderByCheckoutSession, flagOrderAttention } from "@/lib/server/orders-service";
import {
  holdOrderPayment,
  linkOrderContact,
  markOrderExpired,
} from "@/lib/server/product-link-orders";
import { isOrderTerminal, type Order } from "@/types/orders";

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

/**
 * Before a paid session marks a `product_link` order paid:
 *
 *  1. The amount and currency must match the order. If not, the order is
 *     HELD — it stays `pending` (never `paid`, so nothing is delivered or
 *     confirmed) with the payment recorded and the order flagged for the
 *     operator. Returns `held: true` and the caller stops.
 *  2. An order with no contact finds or creates the buyer's contact from
 *     Stripe's email (email-first, the same rule as forms) and is linked to
 *     it, before the order's events fire so a workflow sees the contact.
 *     Runs on every delivery until linked; a failure throws, so Stripe's
 *     redelivery retries it. Idempotent: the email match finds the contact
 *     an earlier attempt created, and the link is set once.
 */
export async function prepareProductLinkPayment(
  order: Order,
  session: Stripe.Checkout.Session,
  paymentIntentId: string | null,
): Promise<{ held: boolean }> {
  const buyer = sessionBuyer(session);

  if (order.status === "pending") {
    const amount = sessionAmountCheck(order, session);
    if (!amount.ok) {
      const held = await holdOrderPayment({
        orderId: order.id,
        stripePaymentIntentId: paymentIntentId,
        buyerEmail: buyer.email,
        buyerName: buyer.name,
      });
      if (held) {
        const note = `Paid ${amount.paidAmount ?? "?"} ${amount.paidCurrency.toUpperCase()} (Stripe units), which differs from this order — it was not marked paid and nothing was delivered. Check it by hand.`;
        console.warn(`[order-reconciler] order ${order.id} held: ${note}`);
        await flagOrderAttention(held, note).catch((err: unknown) => {
          // NOT_FOUND = deleted under us; a retry cannot help.
          if ((err as { code?: unknown })?.code !== 5) throw err;
          console.error(`[order-reconciler] order ${order.id} vanished before its flag`);
        });
      }
      return { held: true };
    }
  }

  if (!order.contactId && buyer.email && !isOrderTerminal(order.status)) {
    const res = await reconcileContactFromCapture({
      agencyId: order.agencyId,
      subAccountId: order.subAccountId,
      existingContactId: null,
      pageUrl: null,
      source: "checkout",
      matchStrategy: "email-first",
      capture: { name: buyer.name, email: buyer.email, phone: buyer.phone },
    });
    if (res?.contactId) await linkOrderContact(order.id, res.contactId);
  }
  return { held: false };
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

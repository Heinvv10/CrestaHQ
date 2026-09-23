import type { Timestamp, FieldValue } from "firebase/firestore";
import type { ContactAttribution } from "@/types/contacts";

/**
 * Orders — Payments v1. One doc per attempted card payment through the
 * sub-account's OWN Stripe account (see `src/types/payments.ts`).
 *
 * Top-level collection with tenancy keys, matching `quotes` / `socialPosts` /
 * `voiceCampaigns` rather than a subcollection. Orders are operator-facing
 * documents with their own list page (the same reason quotes went top-level),
 * and Phase B puts them side by side with quotes — an invoice paid by card
 * produces one of each.
 *
 * Money is integer cents throughout, matching `Product.unitPriceCents`.
 *
 * Line items are SNAPSHOTTED at checkout — editing or archiving a product
 * later never mutates a historical order. `productId` is a back-reference
 * only, exactly like quote line items.
 */

export type OrderStatus =
  | "pending"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "failed";

/** Where the order came from. Only `checkout_page` exists in v1; the rest are
 *  Phase B adopters, declared now so the reconciler never needs widening. */
export type OrderSource =
  | "checkout_page"
  | "quote"
  | "booking_deposit"
  | "community";

export interface OrderLineItem {
  /** Back-reference. Null for ad-hoc items with no catalog entry. */
  productId: string | null;
  name: string;
  description: string;
  unitPriceCents: number;
  quantity: number;
  /** True when this line came from an order bump rather than the main offer.
   *  Drives bump take-rate reporting — the whole point of the feature. */
  isBump: boolean;
}

export interface Order {
  id: string;

  // ── Tenancy ───────────────────────────────────────────────────────
  agencyId: string;
  subAccountId: string;

  contactId: string | null;
  checkoutPageId: string | null;
  /**
   * The invoice this order paid, when `source === "quote"`. Null otherwise.
   * Explicit rather than a generic `sourceRefId` so it's greppable and so a
   * future booking-deposit order can carry its own `eventId` without either
   * field being ambiguous.
   */
  quoteId: string | null;
  /** The booking whose deposit this order paid, when
   *  `source === "booking_deposit"`. Null otherwise. */
  eventId: string | null;
  /** Community purchase this order paid, when `source === "community"`.
   *  Purchases are nested under a group, so both ids are needed to address
   *  one. Null otherwise. */
  communityGroupId: string | null;
  purchaseId: string | null;
  source: OrderSource;

  status: OrderStatus;
  /** ISO 4217, lowercased to match Stripe. */
  currency: string;
  lineItems: OrderLineItem[];
  subtotalCents: number;
  totalCents: number;
  refundedCents: number;

  // ── Stripe linkage (the client's own account, in BOTH tiers) ──────
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  /** False when the connection was a test-mode key — keeps play money out of
   *  real reporting without a second collection. */
  livemode: boolean;

  /** Buyer details as Stripe saw them. Kept even when `contactId` is null so
   *  an unreconciled order is still actionable. */
  buyerEmail: string | null;
  buyerName: string | null;

  /**
   * First-touch attribution copied off the contact at order creation, so a
   * later contact edit can't rewrite revenue history. Mirrors the
   * snapshot-don't-reference rule used for line items.
   */
  attribution: ContactAttribution | null;

  /**
   * Set when the money arrived but the invoice / booking it paid for could not
   * be settled with it (second payment, amount changed, booking no longer
   * waiting). The operator must act by hand — refund or reconcile.
   */
  attention?: string | null;

  createdAt: Timestamp | FieldValue | null;
  paidAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Sum of line items. Pure — used by the service, the checkout page, and any
 *  future reporting so the number can't drift between them. */
export function computeOrderSubtotalCents(items: OrderLineItem[]): number {
  return items.reduce(
    (sum, li) => sum + li.unitPriceCents * li.quantity,
    0,
  );
}

/** Terminal statuses — the reconciler must not move an order out of these. */
export function isOrderTerminal(status: OrderStatus): boolean {
  return status === "refunded" || status === "failed";
}

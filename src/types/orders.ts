import type { Timestamp, FieldValue } from "firebase/firestore";
import type { ContactAttribution } from "@/types/contacts";
import type { ProductDelivery } from "@/types/products";

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
  | "failed"
  /** A `product_link` order whose Stripe session expired unpaid. */
  | "expired";

/** Where the order came from. Only `checkout_page` exists in v1; the rest are
 *  Phase B adopters, declared now so the reconciler never needs widening. */
export type OrderSource =
  | "checkout_page"
  | "quote"
  | "booking_deposit"
  | "community"
  | "product_link";

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

/** What a product promised the buyer, copied onto the order at checkout so a
 *  later product edit can't change what was bought. */
export interface OrderDeliverySnapshot {
  productId: string;
  delivery: Exclude<ProductDelivery, { type: "none" }>;
}

export interface OrderConfirmationStatus {
  state: "sending" | "sent" | "failed";
  error: string | null;
  /** Epoch ms. */
  at: number;
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

  /** The product an express buy link sold, when `source === "product_link"`. */
  productLinkProductId?: string | null;
  /** Set for `product_link`: what the buyer gets once paid (download link,
   *  community access). Shown on the thanks page only once paid. */
  deliveries?: OrderDeliverySnapshot[];
  /** SHA-256 (hex) of the token in a `product_link` order's thanks-page URL.
   *  The page shows the order only to a holder of that token. */
  thanksTokenHash?: string;
  /** Set on a `product_link` order whose payment didn't match it (amount or
   *  currency). A held order is never `paid`, never delivered and never
   *  counted as revenue, whatever later events say. */
  heldAt?: Timestamp | FieldValue | Date | null;
  /** `product_link`: when its `order.paid` events were claimed (once). */
  paidEventsFiredAt?: Timestamp | FieldValue | null;
  /** Set for `product_link`: the order confirmation emailed to the buyer.
   *  Claimed (`sending`) in a transaction before the send, so it goes once. */
  confirmationEmail?: OrderConfirmationStatus | null;

  // ── Stripe linkage (the client's own account, in BOTH tiers) ──────
  /** Empty on a `product_link` order between its write and the session
   *  creation that follows (the order is written first). */
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
  /** True while `attention` awaits a person; false once resolved. Absent on
   *  orders flagged before resolution existed. */
  attentionOpen?: boolean;
  attentionResolvedAt?: Timestamp | FieldValue | null;
  attentionResolvedByUid?: string | null;
  attentionResolvedByEmail?: string | null;

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
  return status === "refunded" || status === "failed" || status === "expired";
}

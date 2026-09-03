import "server-only";

import type { BillingInterval } from "@/types/billing";
import { StripeBillingProvider } from "./stripe-provider";

/**
 * Provider-agnostic contract for **Client Billing** — the agency charging its
 * sub-accounts on the DEPLOYMENT's own payment account (one agency per
 * deployment, no Connect).
 *
 * Deliberately NOT under `lib/stripe/`: the whole point is that
 * `billing-service.ts` talks to this interface and never to a provider SDK, so
 * a second provider (Paystack) can be dropped in behind `getBillingProvider()`.
 *
 * Out of scope for this interface (they are separate integrations):
 *   - Payments v1 — a sub-account charging ITS OWN customers with its own
 *     restricted key (`lib/stripe/sub-account-client.ts`).
 *   - The legacy per-user subscription flow (`users/{uid}`, STRIPE_PRO_PRICE_ID).
 *
 * All ids crossing this boundary are OPAQUE strings — a Stripe `prod_…`/
 * `price_…` and a Paystack plan code are equally valid values. The Firestore
 * field names that store them (`stripeProductId`, `stripePriceId`, …) are
 * unchanged; renaming them is a data migration, not part of this abstraction.
 */
export interface BillingProvider {
  /** Stable identifier for logs/diagnostics. */
  readonly id: "stripe";

  /** True when this deployment has credentials for the provider. */
  isConfigured(): boolean;

  // --- Catalog ------------------------------------------------------------

  /**
   * Create a plan: one product plus a recurring monthly price, and — when
   * `priceAnnualCents` is non-null — a second recurring price billed yearly.
   */
  createPlan(input: CreatePlanInput): Promise<CreatePlanResult>;

  /**
   * Mint ONE recurring price on an existing product. Used when a price is
   * edited (prices are immutable — a change means a new one), when an annual
   * price is added later, and for per-client special prices.
   */
  createPrice(input: CreatePriceInput): Promise<{ priceId: string }>;

  /**
   * Retire a price so no new checkout can use it. Existing subscriptions keep
   * billing at the price they signed up on.
   */
  deactivatePrice(priceId: string): Promise<void>;

  /** Keep the product's display fields in sync with the plan doc. */
  updateProduct(
    productId: string,
    input: { name?: string; description?: string }
  ): Promise<void>;

  // --- Customers + checkout ----------------------------------------------

  /**
   * Return the sub-account's customer, creating one only when
   * `existingCustomerId` is absent. `created` tells the caller whether the id
   * is new and therefore needs persisting.
   */
  ensureCustomer(input: EnsureCustomerInput): Promise<EnsureCustomerResult>;

  /** Hosted checkout that starts a recurring subscription. */
  createSubscriptionCheckout(
    input: SubscriptionCheckoutInput
  ): Promise<CheckoutResult>;

  /**
   * Hosted checkout for a one-time charge, priced ad hoc — no catalog product
   * is created for it.
   */
  createOneTimeCheckout(input: OneTimeCheckoutInput): Promise<CheckoutResult>;

  // --- Subscription lifecycle --------------------------------------------

  /**
   * Move a live subscription onto a different price.
   *
   * `timing` is explicit because providers differ: Stripe can prorate the
   * switch mid-cycle, while a provider without proration can only apply the
   * new price from the next renewal.
   */
  switchSubscriptionPlan(input: SwitchSubscriptionInput): Promise<void>;

  /** Cancel a subscription immediately. */
  cancelSubscription(subscriptionId: string): Promise<void>;

  /**
   * A hosted page where the payer manages their own billing (card, invoices).
   * A provider with no such surface throws a `BillingError` instead.
   */
  createManagementLink(input: ManagementLinkInput): Promise<{ url: string }>;
}

/** How a mid-cycle plan switch should be charged. */
export type PlanSwitchTiming =
  /** Charge/credit the difference now (Stripe `create_prorations`). */
  | "immediate_prorated"
  /** Apply the new price from the next renewal; no mid-cycle adjustment. */
  | "period_end";

export interface CreatePlanInput {
  agencyId: string;
  planId: string;
  name: string;
  description: string | null;
  currency: string;
  priceMonthlyCents: number;
  /** null = monthly-only. */
  priceAnnualCents: number | null;
}

export interface CreatePlanResult {
  productId: string;
  monthlyPriceId: string;
  annualPriceId: string | null;
}

export interface CreatePriceInput {
  productId: string;
  unitAmountCents: number;
  currency: string;
  interval: BillingInterval;
  /** Passed through to the provider verbatim. */
  metadata: Record<string, string>;
}

export interface EnsureCustomerInput {
  /** Already-known customer id; when set, no customer is created. */
  existingCustomerId: string | null;
  name: string;
  email: string | null;
  metadata: Record<string, string>;
}

export interface EnsureCustomerResult {
  customerId: string;
  /** True when a new customer was created and the id must be persisted. */
  created: boolean;
}

export interface SubscriptionCheckoutInput {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface OneTimeCheckoutInput {
  /** Attach to an existing customer when one exists; null = guest checkout. */
  customerId: string | null;
  currency: string;
  amountCents: number;
  /** What the payer sees on the checkout line item. */
  productName: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

export interface SwitchSubscriptionInput {
  subscriptionId: string;
  priceId: string;
  timing: PlanSwitchTiming;
  metadata: Record<string, string>;
}

export interface ManagementLinkInput {
  customerId: string;
  returnUrl: string;
}

let cached: BillingProvider | null = null;

/**
 * The Client Billing provider for this deployment.
 *
 * Always Stripe today. Environment-driven selection lands with the second
 * provider — adding it here is the only change the call sites need.
 */
export function getBillingProvider(): BillingProvider {
  if (!cached) cached = new StripeBillingProvider();
  return cached;
}

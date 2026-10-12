import "server-only";

import {
  createPaystackCustomer,
  createPaystackPlan,
  disablePaystackSubscription,
  findLivePaystackSubscription,
  initializePaystackTransaction,
  readPaystackCustomerEmail,
  readPaystackManageLink,
  readPaystackPlanAmount,
  readPaystackSubscription,
  type PaystackSubscription,
} from "@/lib/paystack/billing-api";
import { paystackIsConfigured } from "@/lib/paystack/client";
import { BillingError } from "./errors";
import { switchPaystackSubscriptionPlan } from "./paystack-plan-switch";
import type {
  BillingProvider,
  CancelOutcome,
  CheckoutResult,
  CreatePlanInput,
  CreatePlanResult,
  CreatePriceInput,
  EnsureCustomerInput,
  EnsureCustomerResult,
  ManagementLinkInput,
  OneTimeCheckoutInput,
  SubscriptionCheckoutInput,
  SwitchSubscriptionInput,
} from "./provider";

/** Paystack subscription statuses that still charge (attention = a failed renewal it retries). */
const PAYSTACK_LIVE_SUBSCRIPTION = new Set(["active", "attention"]);

/**
 * Client Billing on the deployment's own Paystack account — the rail South
 * African agencies actually have, because Stripe will not onboard an SA entity
 * for SaaS-mode rebilling.
 *
 * Paystack's model is flatter than Stripe's, and three of the interface's
 * concepts have no counterpart. Each is resolved here rather than leaking into
 * `billing-service.ts`:
 *
 *   - **No product/price split.** A Paystack Plan *is* the price, so
 *     `productId` is a synthetic handle that only round-trips through
 *     Firestore, and `updateProduct` / `deactivatePrice` are no-ops — see their
 *     comments for what that costs.
 *   - **No proration.** A mid-cycle switch is impossible, so
 *     `immediate_prorated` is refused rather than silently downgraded to a free
 *     upgrade or a double charge.
 *   - **No customer-level portal.** `createManagementLink` resolves the
 *     customer's live subscription and returns Paystack's per-subscription
 *     manage link.
 */
export class PaystackBillingProvider implements BillingProvider {
  readonly id = "paystack" as const;

  /** Paystack has no proration, so a switch can only land at the renewal. */
  readonly planSwitchTiming = "period_end" as const;

  isConfigured(): boolean {
    return paystackIsConfigured();
  }

  // --- Catalog ------------------------------------------------------------

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult> {
    const monthlyPriceId = await createPaystackPlan({
      name: input.name,
      description: input.description,
      amountCents: input.priceMonthlyCents,
      currency: input.currency,
      interval: "month",
    });

    const annualPriceId =
      input.priceAnnualCents === null
        ? null
        : await createPaystackPlan({
            name: `${input.name} (annual)`,
            description: input.description,
            amountCents: input.priceAnnualCents,
            currency: input.currency,
            interval: "year",
          });

    return {
      // Synthetic: Paystack has no product to point at, and the plan codes are
      // stored separately anyway. Deriving it from our own plan id keeps it
      // stable across price edits, which a plan code would not be.
      productId: `psk_plan_${input.planId}`,
      monthlyPriceId,
      annualPriceId,
    };
  }

  async createPrice(input: CreatePriceInput): Promise<{ priceId: string }> {
    const priceId = await createPaystackPlan({
      name:
        input.interval === "year"
          ? `${input.productName} (annual)`
          : input.productName,
      description: null,
      amountCents: input.unitAmountCents,
      currency: input.currency,
      interval: input.interval,
    });
    return { priceId };
  }

  /**
   * No-op: Paystack has no "retire a plan" operation, and renaming one would
   * rewrite what existing subscribers see on their own receipts.
   *
   * Nothing is lost. A plan code only reaches checkout by being stored on the
   * plan doc, and every caller has just overwritten that field (a price edit)
   * or archived the plan. No client can name a retired plan code themselves.
   */
  async deactivatePrice(_priceId: string): Promise<void> {}

  /**
   * No-op: with no product object, a rename could only touch the live plans —
   * and that rewrites the plan name on the receipts of everyone already
   * subscribed. A renamed plan reaches Paystack the next time a price is
   * minted; until then the Paystack dashboard shows the original name while
   * the app shows the new one.
   */
  async updateProduct(
    _productId: string,
    _input: { name?: string; description?: string },
  ): Promise<void> {}

  // --- Customers + checkout ----------------------------------------------

  async ensureCustomer(
    input: EnsureCustomerInput,
  ): Promise<EnsureCustomerResult> {
    if (input.existingCustomerId) {
      return { customerId: input.existingCustomerId, created: false };
    }
    const email = input.email?.trim();
    if (!email) {
      // Paystack keys every customer on an email address; there is no
      // anonymous customer to fall back to.
      throw new BillingError(
        "Paystack needs an email for this workspace — set its account contact before billing it.",
      );
    }
    const customerId = await createPaystackCustomer({
      email,
      name: input.name,
      metadata: input.metadata,
    });
    return { customerId, created: true };
  }

  async createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Promise<CheckoutResult> {
    // Paystack initializes against an email, not a customer code, so the
    // customer has to be read back before checkout can open. The plan's amount
    // is read for the same reason — see `readPaystackPlanAmount`.
    const [email, amountCents] = await Promise.all([
      readPaystackCustomerEmail(input.customerId),
      readPaystackPlanAmount(input.priceId),
    ]);
    const { url, reference } = await initializePaystackTransaction({
      email,
      amountCents,
      plan: input.priceId,
      callbackUrl: input.successUrl,
      metadata: input.metadata,
    });
    return { url, sessionId: reference };
  }

  async createOneTimeCheckout(
    input: OneTimeCheckoutInput,
  ): Promise<CheckoutResult> {
    const email = input.customerId
      ? await readPaystackCustomerEmail(input.customerId)
      : input.payerEmail?.trim();
    if (!email) {
      throw new BillingError(
        "Paystack needs an email to open a payment page — set this workspace's account contact first.",
      );
    }
    const { url, reference } = await initializePaystackTransaction({
      email,
      amountCents: input.amountCents,
      currency: input.currency,
      callbackUrl: input.successUrl,
      metadata: { ...input.metadata, productName: input.productName },
      displayName: input.productName,
    });
    return { url, sessionId: reference };
  }

  // --- Subscription lifecycle --------------------------------------------

  /** See `switchPaystackSubscriptionPlan`. */
  switchSubscriptionPlan(
    input: SwitchSubscriptionInput,
  ): Promise<{ subscriptionId: string }> {
    return switchPaystackSubscriptionPlan(input);
  }

  /**
   * Paystack refuses to disable a subscription that is no longer live, so
   * one it has already ended (non-renewing, completed, cancelled) or no
   * longer knows (404) is reported as such instead of failing. A status it
   * does not report is treated as live: disabled, or the failure thrown.
   */
  async cancelSubscription(subscriptionId: string): Promise<CancelOutcome> {
    let sub: PaystackSubscription;
    try {
      sub = await readPaystackSubscription(subscriptionId);
    } catch (err) {
      if (err instanceof BillingError && err.providerStatus === 404) return "already_cancelled";
      throw err;
    }
    if (sub.status && !PAYSTACK_LIVE_SUBSCRIPTION.has(sub.status)) return "already_cancelled";
    await disablePaystackSubscription(sub);
    return "cancelled";
  }

  /**
   * Paystack has no customer-level portal, so the customer's live subscription
   * is resolved first and its manage page returned. `returnUrl` has no
   * counterpart and is ignored — the managed page closes rather than
   * redirecting.
   */
  async createManagementLink(
    input: ManagementLinkInput,
  ): Promise<{ url: string }> {
    const subscriptionCode = await findLivePaystackSubscription(
      input.customerId,
    );
    return { url: await readPaystackManageLink(subscriptionCode) };
  }
}


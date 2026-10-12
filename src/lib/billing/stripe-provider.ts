import "server-only";

import type Stripe from "stripe";
import { getStripeServer } from "@/lib/stripe/server";
import { BillingError, SubscriptionNotOnAccount } from "./errors";
import { SUB_ACCOUNT_PLAN_KIND } from "./kinds";
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
  PlanSwitchTiming,
  SubscriptionCheckoutInput,
  SwitchSubscriptionInput,
} from "./provider";

/**
 * Client Billing on the deployment's own Stripe account — the behaviour
 * `billing-service.ts` has always had, now behind the provider interface.
 *
 * NOT to be confused with `lib/stripe/sub-account-client.ts` (Payments v1),
 * which uses a sub-account's OWN restricted key to charge that client's
 * customers. This adapter only ever touches `getStripeServer()`.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly id = "stripe" as const;

  /** Stripe swaps the price on the live subscription and settles the difference. */
  readonly planSwitchTiming = "immediate_prorated" as const;

  isConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY?.trim();
  }

  private get stripe(): Stripe {
    return getStripeServer();
  }

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult> {
    const product = await this.stripe.products.create({
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      metadata: {
        kind: SUB_ACCOUNT_PLAN_KIND,
        agencyId: input.agencyId,
        planId: input.planId,
      },
    });
    const price = await this.stripe.prices.create({
      product: product.id,
      unit_amount: input.priceMonthlyCents,
      currency: input.currency,
      recurring: { interval: "month" },
      metadata: { planId: input.planId },
    });

    // Optional annual price — a second recurring Price on the same Product.
    let annualPriceId: string | null = null;
    if (input.priceAnnualCents !== null) {
      const annual = await this.stripe.prices.create({
        product: product.id,
        unit_amount: input.priceAnnualCents,
        currency: input.currency,
        recurring: { interval: "year" },
        metadata: { planId: input.planId, interval: "year" },
      });
      annualPriceId = annual.id;
    }

    return {
      productId: product.id,
      monthlyPriceId: price.id,
      annualPriceId,
    };
  }

  async createPrice(input: CreatePriceInput): Promise<{ priceId: string }> {
    const price = await this.stripe.prices.create({
      product: input.productId,
      unit_amount: input.unitAmountCents,
      currency: input.currency,
      recurring: { interval: input.interval },
      metadata: input.metadata,
    });
    return { priceId: price.id };
  }

  async deactivatePrice(priceId: string): Promise<void> {
    await this.stripe.prices.update(priceId, { active: false });
  }

  async updateProduct(
    productId: string,
    input: { name?: string; description?: string }
  ): Promise<void> {
    await this.stripe.products.update(productId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    });
  }

  async ensureCustomer(
    input: EnsureCustomerInput
  ): Promise<EnsureCustomerResult> {
    if (input.existingCustomerId) {
      return { customerId: input.existingCustomerId, created: false };
    }
    const customer = await this.stripe.customers.create({
      name: input.name,
      ...(input.email ? { email: input.email } : {}),
      metadata: input.metadata,
    });
    return { customerId: customer.id, created: true };
  }

  async createSubscriptionCheckout(
    input: SubscriptionCheckoutInput
  ): Promise<CheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      // Stamped on the subscription too so the webhook can route on it even
      // when it never sees the originating session.
      subscription_data: { metadata: input.metadata },
    });
    return this.checkoutResult(session);
  }

  async createOneTimeCheckout(
    input: OneTimeCheckoutInput
  ): Promise<CheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      ...(input.customerId ? { customer: input.customerId } : {}),
      line_items: [
        {
          price_data: {
            currency: input.currency,
            unit_amount: input.amountCents,
            product_data: { name: input.productName },
          },
          quantity: 1,
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      payment_intent_data: { metadata: input.metadata },
    });
    return this.checkoutResult(session);
  }

  async switchSubscriptionPlan(
    input: SwitchSubscriptionInput,
  ): Promise<{ subscriptionId: string }> {
    const sub = await this.stripe.subscriptions.retrieve(input.subscriptionId);
    const item = sub.items.data[0];
    if (!item) {
      throw new BillingError(
        "The Stripe subscription has no items — resolve it in the Stripe dashboard.",
        500
      );
    }
    await this.stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: input.priceId }],
      proration_behavior: prorationBehavior(input.timing),
      metadata: input.metadata,
    });
    // Stripe mutates in place: the id the caller already stored is still live.
    return { subscriptionId: sub.id };
  }

  /** A subscription Stripe reports ended is `already_cancelled`. One it
   *  doesn't have (resource_missing) is only when this account has the
   *  customer and nothing of theirs still charges — a wrong key or test vs
   *  live proves nothing — else it fails closed. Any other failure throws. */
  async cancelSubscription(subscriptionId: string, customerId: string | null): Promise<CancelOutcome> {
    try {
      await this.stripe.subscriptions.cancel(subscriptionId);
      return "cancelled";
    } catch (err) {
      if ((err as { code?: unknown }).code === "resource_missing") {
        if (customerId && (await this.customerHasNothingLive(customerId))) return "already_cancelled";
        throw new SubscriptionNotOnAccount(
          "Subscription not found on this Stripe account — check the dashboard and the configured key; nothing changed.",
        );
      }
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
      if (sub?.status === "canceled" || sub?.status === "incomplete_expired") return "already_cancelled";
      throw err;
    }
  }

  /** Canceled or incomplete_expired on this account; any read failure is false. */
  async subscriptionEnded(subscriptionId: string): Promise<boolean> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
    return sub?.status === "canceled" || sub?.status === "incomplete_expired";
  }

  /** True only when this account has the customer and none of their subscriptions charges. */
  private async customerHasNothingLive(customerId: string): Promise<boolean> {
    const customer = await this.stripe.customers.retrieve(customerId).catch(() => null);
    if (!customer || ("deleted" in customer && customer.deleted)) return false;
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    if (subs.has_more) return false;
    return !subs.data.some((s) => ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(s.status));
  }

  async createManagementLink(
    input: ManagementLinkInput
  ): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  private checkoutResult(session: Stripe.Checkout.Session): CheckoutResult {
    if (!session.url) {
      throw new BillingError("Stripe did not return a checkout URL.", 502);
    }
    return { url: session.url, sessionId: session.id };
  }
}

/**
 * `period_end` maps to `none`: Stripe swaps the price straight away but issues
 * no mid-cycle credit or charge, so the new amount first bills at renewal.
 */
function prorationBehavior(
  timing: PlanSwitchTiming
): Stripe.SubscriptionUpdateParams.ProrationBehavior {
  return timing === "immediate_prorated" ? "create_prorations" : "none";
}

import "server-only";

import {
  createPaystackCustomer,
  createPaystackPlan,
  createPaystackSubscription,
  disablePaystackSubscription,
  findLivePaystackSubscription,
  initializePaystackTransaction,
  readPaystackCustomerEmail,
  readPaystackManageLink,
  readPaystackPlanAmount,
  readPaystackSubscription,
} from "@/lib/paystack/billing-api";
import { paystackIsConfigured } from "@/lib/paystack/client";
import { BillingError } from "./errors";
import type {
  BillingProvider,
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

  /**
   * Paystack cannot move a live subscription onto another plan, so the switch
   * is a disable plus a fresh subscription starting the day the old one would
   * have renewed — the client is never double-charged and never gets a free
   * period.
   *
   * The returned id is a NEW subscription code and the caller must store it —
   * the one it passed in is dead by the time this returns.
   *
   * `metadata` is unused: Paystack's subscription-create endpoint takes none.
   */
  async switchSubscriptionPlan(
    input: SwitchSubscriptionInput,
  ): Promise<{ subscriptionId: string }> {
    if (input.timing === "immediate_prorated") {
      throw new BillingError(
        "Paystack can't prorate a mid-cycle switch — apply it at the renewal date instead.",
        501,
      );
    }
    const sub = await readPaystackSubscription(input.subscriptionId);
    const authorizationCode = sub.authorization?.authorization_code;
    const customerCode = sub.customer?.customer_code;
    if (!authorizationCode || !customerCode || !sub.next_payment_date) {
      throw new BillingError(
        "This Paystack subscription has no saved card or renewal date — switch it in the Paystack dashboard.",
        500,
      );
    }

    // The old subscription goes first: creating the replacement first would
    // bill both over the overlap, and a double charge is worse than a gap.
    await disablePaystackSubscription(sub);
    try {
      const subscriptionId = await createPaystackSubscription({
        customerCode,
        planCode: input.priceId,
        authorizationCode,
        startDate: sub.next_payment_date,
      });
      return { subscriptionId };
    } catch (err) {
      // There is no transaction across a third party, so the window between
      // the two calls cannot be closed — only made impossible to miss. The
      // client now has NO live subscription; say exactly that, and name the
      // dead code so the state can be reconstructed from the log alone.
      console.error(
        `[billing] Paystack plan switch left sub-account unsubscribed: ${sub.subscription_code} was disabled, plan ${input.priceId} was not started`,
        err,
      );
      throw new BillingError(
        `The old subscription was cancelled but the new one didn't start, so this workspace has no live subscription. Re-assign the plan to restore it. (${err instanceof Error ? err.message : String(err)})`,
        502,
      );
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await disablePaystackSubscription(
      await readPaystackSubscription(subscriptionId),
    );
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

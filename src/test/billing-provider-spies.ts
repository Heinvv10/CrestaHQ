import { afterEach, vi } from "vitest";
import { getBillingProvider, resetBillingProviderForTests, type BillingProvider } from "@/lib/billing/provider";

/**
 * The REAL Client Billing provider this deployment would select, chosen the
 * way production chooses it (env + `resetBillingProviderForTests`), with every
 * method that would reach Stripe or Paystack replaced by a spy. `none` is the
 * unconfigured default: Stripe selected, no key. Nothing here ever reaches a
 * real payment account.
 */

export type ProviderKind = "stripe" | "paystack" | "none";

const ENV = ["STRIPE_SECRET_KEY", "PAYSTACK_SECRET_KEY", "BILLING_PROVIDER"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const METHODS = [
  "createPlan", "createPrice", "deactivatePrice", "updateProduct", "ensureCustomer",
  "createSubscriptionCheckout", "createOneTimeCheckout", "switchSubscriptionPlan",
  "cancelSubscription", "createManagementLink",
] as const;

const RESULTS: Partial<Record<(typeof METHODS)[number], unknown>> = {
  createPlan: { productId: "prod_spy", monthlyPriceId: "price_spy", annualPriceId: null },
  createPrice: { priceId: "price_special_spy" },
  switchSubscriptionPlan: { subscriptionId: "sub_after_switch" },
};

export type ProviderSpies = Record<(typeof METHODS)[number], ReturnType<typeof vi.fn>> & {
  provider: BillingProvider;
  /** Every provider call so far, across all methods. */
  calls: () => number;
};

export function useBillingProvider(kind: ProviderKind): ProviderSpies {
  for (const k of ENV) delete process.env[k];
  if (kind === "stripe") process.env.STRIPE_SECRET_KEY = "sk_test_spy";
  if (kind === "paystack") {
    process.env.BILLING_PROVIDER = "paystack";
    process.env.PAYSTACK_SECRET_KEY = "sk_test_spy";
  }
  resetBillingProviderForTests();
  const provider = getBillingProvider();
  const spies = Object.fromEntries(
    METHODS.map((m) => [m, vi.spyOn(provider, m).mockImplementation((async () => RESULTS[m]) as never)])
  ) as unknown as ProviderSpies;
  spies.provider = provider;
  spies.calls = () => METHODS.reduce((n, m) => n + spies[m].mock.calls.length, 0);
  return spies;
}

/** Restores the environment and drops the memoized provider after each test. */
export function restoreBillingProviderAfterEach() {
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetBillingProviderForTests();
  });
}

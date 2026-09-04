import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which payment rail this deployment bills on.
 *
 * Getting this wrong charges real clients on the wrong account, so selection
 * is pinned rather than left to whichever adapter happens to be imported.
 */

vi.mock("@/lib/stripe/server", () => ({ getStripeServer: () => ({}) }));

const { getBillingProvider, resetBillingProviderForTests } = await import(
  "./provider"
);

const saved = {
  stripe: process.env.STRIPE_SECRET_KEY,
  paystack: process.env.PAYSTACK_SECRET_KEY,
  forced: process.env.BILLING_PROVIDER,
};

function setEnv(env: {
  stripe?: string;
  paystack?: string;
  forced?: string;
}) {
  for (const [key, name] of [
    ["stripe", "STRIPE_SECRET_KEY"],
    ["paystack", "PAYSTACK_SECRET_KEY"],
    ["forced", "BILLING_PROVIDER"],
  ] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetBillingProviderForTests();
}

beforeEach(() => resetBillingProviderForTests());

afterEach(() => {
  setEnv({
    stripe: saved.stripe,
    paystack: saved.paystack,
    forced: saved.forced,
  });
});

describe("getBillingProvider", () => {
  it("uses Paystack when only Paystack is configured", () => {
    setEnv({ paystack: "sk_live_p" });
    expect(getBillingProvider().id).toBe("paystack");
  });

  it("uses Stripe when only Stripe is configured", () => {
    setEnv({ stripe: "sk_live_s" });
    expect(getBillingProvider().id).toBe("stripe");
  });

  it("keeps billing on Stripe when both keys are present", () => {
    // A deployment mid-migration still holds its Stripe key. Silently moving
    // its live subscribers to a second account would be the worse default.
    setEnv({ stripe: "sk_live_s", paystack: "sk_live_p" });
    expect(getBillingProvider().id).toBe("stripe");
  });

  it("lets BILLING_PROVIDER settle the tie explicitly", () => {
    setEnv({ stripe: "sk_live_s", paystack: "sk_live_p", forced: "paystack" });
    expect(getBillingProvider().id).toBe("paystack");
  });

  it("falls back to Stripe when nothing is configured, so isConfigured stays false", () => {
    setEnv({});
    const provider = getBillingProvider();
    expect(provider.id).toBe("stripe");
    expect(provider.isConfigured()).toBe(false);
  });

  it("memoizes so every call site shares one provider", () => {
    setEnv({ paystack: "sk_live_p" });
    expect(getBillingProvider()).toBe(getBillingProvider());
  });
});

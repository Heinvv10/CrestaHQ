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
  it("stays on Stripe when only a Paystack key is pasted in", () => {
    // The trap this closes: Paystack has no webhook receiver yet, so a
    // deployment silently switched onto it would take a client's payment and
    // leave their workspace walled. A key alone must never select the rail.
    setEnv({ paystack: "sk_live_p" });
    expect(getBillingProvider().id).toBe("stripe");
  });

  it("selects Paystack only on an explicit BILLING_PROVIDER", () => {
    setEnv({ paystack: "sk_live_p", forced: "paystack" });
    expect(getBillingProvider().id).toBe("paystack");
  });

  it("keeps billing on Stripe when both keys are present", () => {
    setEnv({ stripe: "sk_live_s", paystack: "sk_live_p" });
    expect(getBillingProvider().id).toBe("stripe");
  });

  it("falls back to Stripe when nothing is configured, so isConfigured stays false", () => {
    setEnv({});
    const provider = getBillingProvider();
    expect(provider.id).toBe("stripe");
    expect(provider.isConfigured()).toBe(false);
  });

  it("declares a switch timing each provider can actually honour", () => {
    // Read by `assignPlanToSubAccount`; a wrong value here misprices a switch.
    setEnv({ stripe: "sk_live_s" });
    expect(getBillingProvider().planSwitchTiming).toBe("immediate_prorated");
    setEnv({ forced: "paystack" });
    expect(getBillingProvider().planSwitchTiming).toBe("period_end");
  });

  it("memoizes so every call site shares one provider", () => {
    setEnv({ forced: "paystack" });
    expect(getBillingProvider()).toBe(getBillingProvider());
  });
});

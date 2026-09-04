import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wire-shape tests for the Client Billing Paystack adapter.
 *
 * Only the HTTP call is mocked, so the request bodies asserted here are the
 * real contract with Paystack. Each assertion pins a decision that moves money
 * if it changes: what a plan costs, whether a checkout bills twice, and who a
 * charge is addressed to.
 */

const paystackRequest = vi.fn();
vi.mock("@/lib/paystack/client", () => ({
  paystackRequest: (...args: unknown[]) => paystackRequest(...args),
  paystackIsConfigured: () => !!process.env.PAYSTACK_SECRET_KEY?.trim(),
}));

const { PaystackBillingProvider } = await import("./paystack-provider");
const { BillingError } = await import("./errors");

let provider: InstanceType<typeof PaystackBillingProvider>;

/** The (method, path, body) of the nth call, for readable assertions. */
function call(n: number) {
  const [method, path, body] = paystackRequest.mock.calls[n] as [
    string,
    string,
    Record<string, unknown> | undefined,
  ];
  return { method, path, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  provider = new PaystackBillingProvider();
});

describe("isConfigured", () => {
  it("follows PAYSTACK_SECRET_KEY", () => {
    const previous = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = "";
    expect(provider.isConfigured()).toBe(false);
    process.env.PAYSTACK_SECRET_KEY = "   ";
    expect(provider.isConfigured()).toBe(false);
    process.env.PAYSTACK_SECRET_KEY = "sk_test_1";
    expect(provider.isConfigured()).toBe(true);
    if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previous;
  });
});

describe("createPlan", () => {
  const input = {
    agencyId: "ag_1",
    planId: "plan_1",
    name: "Growth",
    description: "Everything included",
    currency: "zar",
    priceMonthlyCents: 99000,
    priceAnnualCents: null as number | null,
  };

  it("mints one monthly plan and no annual one when annual is null", async () => {
    paystackRequest.mockResolvedValueOnce({ plan_code: "PLN_m" });

    const result = await provider.createPlan(input);

    expect(paystackRequest).toHaveBeenCalledTimes(1);
    expect(call(0).path).toBe("/plan");
    expect(call(0).body).toMatchObject({
      name: "Growth",
      // Cents pass through unchanged — Paystack takes the subunit, which is
      // the unit the plan docs already store. Any conversion here misprices.
      amount: 99000,
      interval: "monthly",
      currency: "ZAR",
    });
    expect(result.monthlyPriceId).toBe("PLN_m");
    expect(result.annualPriceId).toBeNull();
  });

  it("mints a second plan at the annual interval when a yearly price is set", async () => {
    paystackRequest
      .mockResolvedValueOnce({ plan_code: "PLN_m" })
      .mockResolvedValueOnce({ plan_code: "PLN_y" });

    const result = await provider.createPlan({
      ...input,
      priceAnnualCents: 990000,
    });

    expect(call(1).body).toMatchObject({
      amount: 990000,
      interval: "annually",
    });
    expect(result.annualPriceId).toBe("PLN_y");
  });

  it("refuses a currency Paystack cannot settle", async () => {
    await expect(
      provider.createPlan({ ...input, currency: "gbp" }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(paystackRequest).not.toHaveBeenCalled();
  });

  it("returns a product id derived from the plan id, not a plan code", async () => {
    paystackRequest.mockResolvedValueOnce({ plan_code: "PLN_m" });
    // A plan code changes on every price edit; the stored product handle must
    // not, or a later edit loses the plan it belongs to.
    const result = await provider.createPlan(input);
    expect(result.productId).toBe("psk_plan_plan_1");
  });
});

describe("createPrice", () => {
  it("names the annual plan distinctly so a payer can tell them apart", async () => {
    paystackRequest.mockResolvedValueOnce({ plan_code: "PLN_y" });

    await provider.createPrice({
      productId: "psk_plan_plan_1",
      productName: "Growth",
      unitAmountCents: 990000,
      currency: "ZAR",
      interval: "year",
      metadata: { planId: "plan_1" },
    });

    expect(call(0).body).toMatchObject({
      name: "Growth (annual)",
      interval: "annually",
    });
  });
});

describe("deactivatePrice / updateProduct", () => {
  it("touch Paystack at all, which would rewrite live subscribers' receipts", async () => {
    await provider.deactivatePrice("PLN_old");
    await provider.updateProduct("psk_plan_plan_1", { name: "Renamed" });
    expect(paystackRequest).not.toHaveBeenCalled();
  });
});

describe("ensureCustomer", () => {
  it("reuses a known customer without calling Paystack", async () => {
    const result = await provider.ensureCustomer({
      existingCustomerId: "CUS_1",
      name: "Acme",
      email: "ops@acme.test",
      metadata: {},
    });
    expect(result).toEqual({ customerId: "CUS_1", created: false });
    expect(paystackRequest).not.toHaveBeenCalled();
  });

  it("refuses to create a customer with no email", async () => {
    await expect(
      provider.ensureCustomer({
        existingCustomerId: null,
        name: "Acme",
        email: "  ",
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(paystackRequest).not.toHaveBeenCalled();
  });

  it("flags a newly created customer so the caller persists the code", async () => {
    paystackRequest.mockResolvedValueOnce({ customer_code: "CUS_new" });
    const result = await provider.ensureCustomer({
      existingCustomerId: null,
      name: "Acme",
      email: "ops@acme.test",
      metadata: { subAccountId: "sa_1" },
    });
    expect(result).toEqual({ customerId: "CUS_new", created: true });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wire-shape tests for the Client Billing Stripe adapter.
 *
 * The adapter is the ONLY place Client Billing touches the Stripe SDK, so the
 * argument shapes asserted here are the contract with Stripe. If one of these
 * changes, real money moves differently — a plan switch stops prorating, a
 * checkout stops carrying the `subAccountPlan` metadata the webhook routes on,
 * or a price edit stops retiring the old price.
 */

const stripeMock = {
  products: { create: vi.fn(), update: vi.fn() },
  prices: { create: vi.fn(), update: vi.fn() },
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  billingPortal: { sessions: { create: vi.fn() } },
};

vi.mock("@/lib/stripe/server", () => ({
  getStripeServer: () => stripeMock,
}));

const { StripeBillingProvider } = await import("./stripe-provider");
const { BillingError } = await import("./errors");

let provider: InstanceType<typeof StripeBillingProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  provider = new StripeBillingProvider();
});

describe("isConfigured", () => {
  it("follows STRIPE_SECRET_KEY", () => {
    const previous = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "";
    expect(provider.isConfigured()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "   ";
    expect(provider.isConfigured()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    expect(provider.isConfigured()).toBe(true);
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  });
});

describe("createPlan", () => {
  const input = {
    agencyId: "ag_1",
    planId: "plan_1",
    name: "Growth",
    description: "Everything included",
    currency: "usd",
    priceMonthlyCents: 9900,
    priceAnnualCents: null as number | null,
  };

  it("creates the product + a monthly price, and no annual price by default", async () => {
    stripeMock.products.create.mockResolvedValue({ id: "prod_1" });
    stripeMock.prices.create.mockResolvedValue({ id: "price_m" });

    const result = await provider.createPlan(input);

    expect(stripeMock.products.create).toHaveBeenCalledWith({
      name: "Growth",
      description: "Everything included",
      metadata: {
        kind: "subAccountPlan",
        agencyId: "ag_1",
        planId: "plan_1",
      },
    });
    expect(stripeMock.prices.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.prices.create).toHaveBeenCalledWith({
      product: "prod_1",
      unit_amount: 9900,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { planId: "plan_1" },
    });
    expect(result).toEqual({
      productId: "prod_1",
      monthlyPriceId: "price_m",
      annualPriceId: null,
    });
  });

  it("omits description entirely when there isn't one", async () => {
    stripeMock.products.create.mockResolvedValue({ id: "prod_1" });
    stripeMock.prices.create.mockResolvedValue({ id: "price_m" });

    await provider.createPlan({ ...input, description: null });

    expect(stripeMock.products.create.mock.calls[0][0]).not.toHaveProperty(
      "description"
    );
  });

  it("adds a second yearly price on the same product when annual is set", async () => {
    stripeMock.products.create.mockResolvedValue({ id: "prod_1" });
    stripeMock.prices.create
      .mockResolvedValueOnce({ id: "price_m" })
      .mockResolvedValueOnce({ id: "price_y" });

    const result = await provider.createPlan({
      ...input,
      priceAnnualCents: 99000,
    });

    expect(stripeMock.prices.create).toHaveBeenCalledTimes(2);
    expect(stripeMock.prices.create).toHaveBeenLastCalledWith({
      product: "prod_1",
      unit_amount: 99000,
      currency: "usd",
      recurring: { interval: "year" },
      metadata: { planId: "plan_1", interval: "year" },
    });
    expect(result.annualPriceId).toBe("price_y");
  });
});

describe("createPrice / deactivatePrice / updateProduct", () => {
  it("mints a recurring price at the requested interval, metadata passed through", async () => {
    stripeMock.prices.create.mockResolvedValue({ id: "price_special" });

    const result = await provider.createPrice({
      productId: "prod_1",
      productName: "Growth",
      unitAmountCents: 4900,
      currency: "aud",
      interval: "year",
      metadata: {
        planId: "plan_1",
        specialForSubAccountId: "sa_1",
        interval: "year",
      },
    });

    expect(stripeMock.prices.create).toHaveBeenCalledWith({
      product: "prod_1",
      unit_amount: 4900,
      currency: "aud",
      recurring: { interval: "year" },
      metadata: {
        planId: "plan_1",
        specialForSubAccountId: "sa_1",
        interval: "year",
      },
    });
    expect(result).toEqual({ priceId: "price_special" });
  });

  it("deactivates a price rather than deleting it", async () => {
    stripeMock.prices.update.mockResolvedValue({ id: "price_old" });
    await provider.deactivatePrice("price_old");
    expect(stripeMock.prices.update).toHaveBeenCalledWith("price_old", {
      active: false,
    });
  });

  it("sends only the product fields that were supplied", async () => {
    stripeMock.products.update.mockResolvedValue({ id: "prod_1" });
    await provider.updateProduct("prod_1", { name: "Renamed" });
    expect(stripeMock.products.update).toHaveBeenCalledWith("prod_1", {
      name: "Renamed",
    });

    await provider.updateProduct("prod_1", { description: "" });
    expect(stripeMock.products.update).toHaveBeenLastCalledWith("prod_1", {
      description: "",
    });
  });
});

describe("ensureCustomer", () => {
  it("reuses an existing customer without calling Stripe", async () => {
    const result = await provider.ensureCustomer({
      existingCustomerId: "cus_1",
      name: "Acme",
      email: "a@acme.test",
      metadata: {},
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(result).toEqual({ customerId: "cus_1", created: false });
  });

  it("creates one when there isn't one, flagging it for persistence", async () => {
    stripeMock.customers.create.mockResolvedValue({ id: "cus_new" });

    const result = await provider.ensureCustomer({
      existingCustomerId: null,
      name: "Acme",
      email: "a@acme.test",
      metadata: {
        kind: "subAccountPlan",
        agencyId: "ag_1",
        subAccountId: "sa_1",
      },
    });

    expect(stripeMock.customers.create).toHaveBeenCalledWith({
      name: "Acme",
      email: "a@acme.test",
      metadata: {
        kind: "subAccountPlan",
        agencyId: "ag_1",
        subAccountId: "sa_1",
      },
    });
    expect(result).toEqual({ customerId: "cus_new", created: true });
  });

  it("omits email entirely when the sub-account has no contact email", async () => {
    stripeMock.customers.create.mockResolvedValue({ id: "cus_new" });
    await provider.ensureCustomer({
      existingCustomerId: null,
      name: "Acme",
      email: null,
      metadata: {},
    });
    expect(stripeMock.customers.create.mock.calls[0][0]).not.toHaveProperty(
      "email"
    );
  });
});

describe("createSubscriptionCheckout", () => {
  const input = {
    customerId: "cus_1",
    payerEmail: null,
    priceId: "price_m",
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
    metadata: {
      kind: "subAccountPlan",
      agencyId: "ag_1",
      subAccountId: "sa_1",
      planId: "plan_1",
    },
  };

  it("opens a subscription session and stamps metadata on the subscription too", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: "cs_1",
      url: "https://checkout.test/cs_1",
    });

    const result = await provider.createSubscriptionCheckout(input);

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: "cus_1",
      line_items: [{ price: "price_m", quantity: 1 }],
      success_url: "https://app.test/ok",
      cancel_url: "https://app.test/no",
      metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
    });
    expect(result).toEqual({
      url: "https://checkout.test/cs_1",
      sessionId: "cs_1",
    });
  });

  it("raises a 502 BillingError when Stripe returns no URL", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: "cs_1",
      url: null,
    });
    await expect(provider.createSubscriptionCheckout(input)).rejects.toThrow(
      BillingError
    );
    await expect(
      provider.createSubscriptionCheckout(input)
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("createOneTimeCheckout", () => {
  const base = {
    currency: "usd",
    amountCents: 50000,
    productName: "Web design",
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
    metadata: {
      kind: "subAccountCharge",
      agencyId: "ag_1",
      subAccountId: "sa_1",
      chargeId: "chg_1",
    },
  };

  it("uses ad-hoc price_data in payment mode and reuses the customer", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: "cs_2",
      url: "https://checkout.test/cs_2",
    });

    const result = await provider.createOneTimeCheckout({
      ...base,
      customerId: "cus_1",
      payerEmail: null,
    });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "payment",
      customer: "cus_1",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: 50000,
            product_data: { name: "Web design" },
          },
          quantity: 1,
        },
      ],
      success_url: "https://app.test/ok",
      cancel_url: "https://app.test/no",
      metadata: base.metadata,
      payment_intent_data: { metadata: base.metadata },
    });
    expect(result).toEqual({
      url: "https://checkout.test/cs_2",
      sessionId: "cs_2",
    });
  });

  it("omits the customer key entirely for a client with no Stripe customer", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: "cs_2",
      url: "https://checkout.test/cs_2",
    });
    await provider.createOneTimeCheckout({
      ...base,
      customerId: null,
      payerEmail: null,
    });
    expect(
      stripeMock.checkout.sessions.create.mock.calls[0][0]
    ).not.toHaveProperty("customer");
  });
});

describe("switchSubscriptionPlan", () => {
  const input = {
    subscriptionId: "sub_1",
    priceId: "price_new",
    metadata: {
      kind: "subAccountPlan",
      agencyId: "ag_1",
      subAccountId: "sa_1",
      planId: "plan_2",
    },
  };

  it("moves the single item to the new price WITH prorations for immediate_prorated", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      items: { data: [{ id: "si_1" }] },
    });
    stripeMock.subscriptions.update.mockResolvedValue({ id: "sub_1" });

    await provider.switchSubscriptionPlan({
      ...input,
      timing: "immediate_prorated",
    });

    expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      items: [{ id: "si_1", price: "price_new" }],
      proration_behavior: "create_prorations",
      metadata: input.metadata,
    });
  });

  it("suppresses prorations for period_end", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      items: { data: [{ id: "si_1" }] },
    });
    stripeMock.subscriptions.update.mockResolvedValue({ id: "sub_1" });

    await provider.switchSubscriptionPlan({ ...input, timing: "period_end" });

    expect(
      stripeMock.subscriptions.update.mock.calls[0][1].proration_behavior
    ).toBe("none");
  });

  it("refuses a subscription with no items instead of updating blindly", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      items: { data: [] },
    });

    await expect(
      provider.switchSubscriptionPlan({
        ...input,
        timing: "immediate_prorated",
      })
    ).rejects.toMatchObject({ name: "BillingError", status: 500 });
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("cancelSubscription / createManagementLink", () => {
  it("cancels immediately", async () => {
    stripeMock.subscriptions.cancel.mockResolvedValue({ id: "sub_1" });
    await provider.cancelSubscription("sub_1");
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith("sub_1");
  });

  it("opens a billing portal session pointed back at the given URL", async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: "https://portal.test/x",
    });

    const result = await provider.createManagementLink({
      customerId: "cus_1",
      returnUrl: "https://app.test/sa/sa_1/dashboard/settings",
    });

    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_1",
      return_url: "https://app.test/sa/sa_1/dashboard/settings",
    });
    expect(result).toEqual({ url: "https://portal.test/x" });
  });
});

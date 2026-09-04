import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Checkout and subscription-lifecycle guards for the Paystack adapter.
 *
 * These are the calls that charge a card. Split from
 * `paystack-provider.test.ts` to stay under the file-size cap.
 */

const paystackRequest = vi.fn();
vi.mock("@/lib/paystack/client", () => ({
  paystackRequest: (...args: unknown[]) => paystackRequest(...args),
  paystackIsConfigured: () => true,
}));

const { PaystackBillingProvider } = await import("./paystack-provider");
const { BillingError } = await import("./errors");

let provider: InstanceType<typeof PaystackBillingProvider>;

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

describe("createSubscriptionCheckout", () => {
  const input = {
    customerId: "CUS_1",
    priceId: "PLN_m",
    successUrl: "https://app.test/pay/ok",
    cancelUrl: "https://app.test/pay/cancel",
    metadata: { kind: "subAccountPlan", subAccountId: "sa_1" },
  };

  beforeEach(() => {
    paystackRequest
      .mockResolvedValueOnce({ email: "ops@acme.test" })
      .mockResolvedValueOnce({
        authorization_url: "https://paystack.test/pay/abc",
        reference: "ref_1",
      });
  });

  it("bills the plan's own amount, never a second figure of ours", async () => {
    await provider.createSubscriptionCheckout(input);
    // Paystack errors on an amount that disagrees with the plan, and an
    // amount that agrees today silently diverges after the next price edit.
    expect(call(1).body).not.toHaveProperty("amount");
    expect(call(1).body).toMatchObject({ plan: "PLN_m" });
  });

  it("opens checkout against the customer's email, not the customer code", async () => {
    await provider.createSubscriptionCheckout(input);
    expect(call(0)).toMatchObject({ method: "GET", path: "/customer/CUS_1" });
    expect(call(1).body).toMatchObject({ email: "ops@acme.test" });
  });

  it("returns the transaction reference as the session id", async () => {
    // The reference is what the webhook matches the payment back on.
    const result = await provider.createSubscriptionCheckout(input);
    expect(result).toEqual({
      url: "https://paystack.test/pay/abc",
      sessionId: "ref_1",
    });
  });
});

describe("createOneTimeCheckout", () => {
  const base = {
    currency: "ZAR",
    amountCents: 50000,
    productName: "Web design",
    successUrl: "https://app.test/pay/ok",
    cancelUrl: "https://app.test/pay/cancel",
    metadata: { kind: "subAccountCharge", chargeId: "ch_1" },
  };

  it("refuses to open a page when there is no one to address it to", async () => {
    await expect(
      provider.createOneTimeCheckout({
        ...base,
        customerId: null,
        payerEmail: null,
      }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(paystackRequest).not.toHaveBeenCalled();
  });

  it("uses the payer email when the workspace has no customer yet", async () => {
    paystackRequest.mockResolvedValueOnce({
      authorization_url: "https://paystack.test/pay/x",
      reference: "ref_2",
    });
    await provider.createOneTimeCheckout({
      ...base,
      customerId: null,
      payerEmail: "owner@acme.test",
    });
    expect(call(0).body).toMatchObject({
      email: "owner@acme.test",
      amount: 50000,
      currency: "ZAR",
    });
  });

  it("prefers the stored customer's email over the payer email", async () => {
    paystackRequest
      .mockResolvedValueOnce({ email: "billing@acme.test" })
      .mockResolvedValueOnce({
        authorization_url: "https://paystack.test/pay/y",
        reference: "ref_3",
      });
    await provider.createOneTimeCheckout({
      ...base,
      customerId: "CUS_1",
      payerEmail: "stale@acme.test",
    });
    expect(call(1).body).toMatchObject({ email: "billing@acme.test" });
  });
});

describe("switchSubscriptionPlan", () => {
  const live = {
    subscription_code: "SUB_1",
    email_token: "tok_1",
    next_payment_date: "2026-10-01T00:00:00.000Z",
    authorization: { authorization_code: "AUTH_1" },
    customer: { customer_code: "CUS_1" },
  };

  it("refuses a prorated switch instead of quietly charging the wrong amount", async () => {
    await expect(
      provider.switchSubscriptionPlan({
        subscriptionId: "SUB_1",
        priceId: "PLN_new",
        timing: "immediate_prorated",
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(paystackRequest).not.toHaveBeenCalled();
  });

  it("cancels the old plan before starting the new one, at the renewal date", async () => {
    paystackRequest
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await provider.switchSubscriptionPlan({
      subscriptionId: "SUB_1",
      priceId: "PLN_new",
      timing: "period_end",
      metadata: {},
    });

    // Order is the guard: creating first would bill both plans over the
    // overlap.
    expect(call(1).path).toBe("/subscription/disable");
    expect(call(1).body).toMatchObject({ code: "SUB_1", token: "tok_1" });
    expect(call(2).path).toBe("/subscription");
    expect(call(2).body).toMatchObject({
      customer: "CUS_1",
      plan: "PLN_new",
      authorization: "AUTH_1",
      // Without this the new plan bills today — the client pays twice for the
      // period they have already paid for.
      start_date: "2026-10-01T00:00:00.000Z",
    });
  });

  it("leaves the old subscription running when the new one cannot be scheduled", async () => {
    paystackRequest.mockResolvedValueOnce({
      ...live,
      next_payment_date: null,
    });

    await expect(
      provider.switchSubscriptionPlan({
        subscriptionId: "SUB_1",
        priceId: "PLN_new",
        timing: "period_end",
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(BillingError);

    // Nothing was disabled: a failed switch must not strand a paying client
    // with no subscription at all.
    expect(paystackRequest).toHaveBeenCalledTimes(1);
  });
});

describe("cancelSubscription", () => {
  it("sends the email token Paystack requires to disable", async () => {
    paystackRequest
      .mockResolvedValueOnce({
        subscription_code: "SUB_1",
        email_token: "tok_1",
        next_payment_date: null,
      })
      .mockResolvedValueOnce({});

    await provider.cancelSubscription("SUB_1");

    expect(call(1)).toMatchObject({
      path: "/subscription/disable",
      body: { code: "SUB_1", token: "tok_1" },
    });
  });
});

describe("createManagementLink", () => {
  it("manages the active subscription, not whichever came back first", async () => {
    paystackRequest
      .mockResolvedValueOnce({ id: 42 })
      .mockResolvedValueOnce([
        { subscription_code: "SUB_dead", status: "cancelled" },
        { subscription_code: "SUB_live", status: "active" },
      ])
      .mockResolvedValueOnce({ link: "https://paystack.test/manage/live" });

    const result = await provider.createManagementLink({
      customerId: "CUS_1",
      returnUrl: "https://app.test/settings",
    });

    expect(call(2).path).toBe("/subscription/SUB_live/manage/link");
    expect(result.url).toBe("https://paystack.test/manage/live");
  });

  it("says so rather than returning a dead link when there is no subscription", async () => {
    paystackRequest
      .mockResolvedValueOnce({ id: 42 })
      .mockResolvedValueOnce([]);
    await expect(
      provider.createManagementLink({
        customerId: "CUS_1",
        returnUrl: "https://app.test/settings",
      }),
    ).rejects.toBeInstanceOf(BillingError);
  });
});

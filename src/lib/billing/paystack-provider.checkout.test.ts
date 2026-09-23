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
    // Customer + plan are read in parallel, so match on path, not call order.
    paystackRequest.mockImplementation(async (_m: string, path: string) => {
      if (path.startsWith("/customer/")) return { email: "ops@acme.test" };
      if (path.startsWith("/plan/")) return { amount: 99000 };
      return {
        authorization_url: "https://paystack.test/pay/abc",
        reference: "ref_1",
      };
    });
  });

  function initBody() {
    const found = paystackRequest.mock.calls.find(
      (c) => c[1] === "/transaction/initialize",
    );
    if (!found) throw new Error("no transaction was initialized");
    return found[2] as Record<string, unknown>;
  }

  it("sends the plan's OWN amount alongside the plan code", async () => {
    await provider.createSubscriptionCheckout(input);
    // Paystack documents `amount` as required and also documents `plan` as
    // invalidating it. The plan's own figure is the only value that is right
    // under either reading and cannot disagree with what the client pays.
    expect(initBody()).toMatchObject({ plan: "PLN_m", amount: 99000 });
  });

  it("opens checkout against the customer's email, not the customer code", async () => {
    await provider.createSubscriptionCheckout(input);
    expect(initBody()).toMatchObject({ email: "ops@acme.test" });
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

  it("tells the payer what they are paying for, not just an amount", async () => {
    paystackRequest.mockResolvedValueOnce({
      authorization_url: "https://paystack.test/pay/x",
      reference: "ref_4",
    });
    await provider.createOneTimeCheckout({
      ...base,
      customerId: null,
      payerEmail: "owner@acme.test",
    });
    // Paystack's page has no line item; it renders metadata.custom_fields.
    // Without this the client sees a bare R500 and no reason for it.
    expect(call(0).body).toMatchObject({
      metadata: expect.objectContaining({
        custom_fields: [
          expect.objectContaining({ value: "Web design" }),
        ],
      }),
    });
  });

  it("uppercases the currency Paystack is given", async () => {
    paystackRequest.mockResolvedValueOnce({
      authorization_url: "https://paystack.test/pay/x",
      reference: "ref_5",
    });
    // Plan docs store it lowercase, a Stripe convention. Paystack refuses it.
    await provider.createOneTimeCheckout({
      ...base,
      currency: "zar",
      customerId: null,
      payerEmail: "owner@acme.test",
    });
    expect(call(0).body).toMatchObject({ currency: "ZAR" });
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

  it("refuses when every subscription is dead, instead of handing back a cancelled one", async () => {
    paystackRequest
      .mockResolvedValueOnce({ id: 42 })
      .mockResolvedValueOnce([
        { subscription_code: "SUB_dead", status: "cancelled" },
      ]);
    // A manage page for a cancelled subscription lets the client update a card
    // that bills nothing and shows them a success screen for it.
    await expect(
      provider.createManagementLink({
        customerId: "CUS_1",
        returnUrl: "https://app.test/settings",
      }),
    ).rejects.toBeInstanceOf(BillingError);
  });

  it("looks past the first page for the active subscription", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      subscription_code: `SUB_old_${i}`,
      status: "cancelled",
    }));
    paystackRequest
      .mockResolvedValueOnce({ id: 42 })
      .mockResolvedValueOnce(filler)
      .mockResolvedValueOnce([
        { subscription_code: "SUB_live", status: "active" },
      ])
      .mockResolvedValueOnce({ link: "https://paystack.test/manage/live" });

    const result = await provider.createManagementLink({
      customerId: "CUS_1",
      returnUrl: "https://app.test/settings",
    });

    expect(call(2).path).toContain("page=2");
    expect(result.url).toBe("https://paystack.test/manage/live");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Paystack plan switch — the one call that changes what a live client's
 * card is charged. Only the HTTP call is mocked, routed by path, so the order
 * of Paystack calls asserted here is the real contract.
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

describe("switchSubscriptionPlan", () => {
  const live = {
    subscription_code: "SUB_1",
    email_token: "tok_1",
    status: "active",
    next_payment_date: "2026-10-01T00:00:00.000Z",
    authorization: { authorization_code: "AUTH_1" },
    customer: { customer_code: "CUS_1" },
  };
  const switchPlan = () =>
    provider.switchSubscriptionPlan({
      subscriptionId: "SUB_1",
      priceId: "PLN_new",
      timing: "period_end",
      metadata: {},
    });
  /** Paystack by path; each handler may throw to stand in for a failure. */
  function paystack(over: Record<string, (body?: Record<string, unknown>) => unknown> = {}) {
    const routes: Record<string, (body?: Record<string, unknown>) => unknown> = {
      "GET /subscription/SUB_1": () => live,
      "GET /subscription/SUB_2": () => ({ ...live, subscription_code: "SUB_2", email_token: "tok_2" }),
      "POST /subscription": () => ({ subscription_code: "SUB_2" }),
      "POST /subscription/disable": () => ({}),
      "GET /customer/CUS_1": () => ({ id: 7 }),
      "GET /subscription?customer=7&perPage=100&page=1": () => [],
      ...over,
    };
    paystackRequest.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new Error(`unexpected ${method} ${path}`);
      return handler(body);
    });
  }
  const paths = () => paystackRequest.mock.calls.map((c) => `${c[0]} ${c[1]}`);
  const disabled = () =>
    paystackRequest.mock.calls
      .filter((c) => c[1] === "/subscription/disable")
      .map((c) => (c[2] as { code: string }).code);

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

  it("opens the new subscription at the renewal date BEFORE disabling the old one", async () => {
    paystack();
    // The caller stores this. Hand back the old code and a later cancel
    // disables a dead subscription while SUB_2 keeps debiting the client.
    expect(await switchPlan()).toEqual({ subscriptionId: "SUB_2" });

    // Disabling first left the client with no subscription in between — and
    // the old one's disable webhook could land there and paywall them.
    expect(paths()).toEqual([
      "GET /subscription/SUB_1",
      "POST /subscription",
      "POST /subscription/disable",
    ]);
    expect(call(1).body).toMatchObject({
      customer: "CUS_1",
      plan: "PLN_new",
      authorization: "AUTH_1",
      // Without this the new plan bills today — the client pays twice for the
      // period they have already paid for.
      start_date: "2026-10-01T00:00:00.000Z",
    });
    expect(call(2).body).toMatchObject({ code: "SUB_1", token: "tok_1" });
  });

  it("leaves the old subscription running when the new one cannot be scheduled", async () => {
    paystack({ "GET /subscription/SUB_1": () => ({ ...live, next_payment_date: null }) });
    await expect(switchPlan()).rejects.toBeInstanceOf(BillingError);
    expect(paths()).toEqual(["GET /subscription/SUB_1"]);
  });

  it("carries on when the create timed out but Paystack did open the subscription", async () => {
    paystack({
      "POST /subscription": () => {
        throw new Error("The operation was aborted due to timeout");
      },
      "GET /subscription?customer=7&perPage=100&page=1": () => [
        { subscription_code: "SUB_1", status: "active", plan: { plan_code: "PLN_old" } },
        { subscription_code: "SUB_2", status: "active", plan: { plan_code: "PLN_new" }, createdAt: new Date().toISOString() },
      ],
    });
    // Reporting failure here tells the agency to re-assign — a second live
    // subscription on the same card.
    expect(await switchPlan()).toEqual({ subscriptionId: "SUB_2" });
    expect(disabled()).toEqual(["SUB_1"]);
  });

  it("says nothing changed, and disables nothing, when the new plan really did not start", async () => {
    paystack({
      "POST /subscription": () => {
        throw new Error("Paystack: plan not found");
      },
    });
    await expect(switchPlan()).rejects.toThrow(/nothing changed/i);
    expect(disabled()).toEqual([]);
  });

  it("does not mistake another workspace's older subscription on the same plan for the new one", async () => {
    paystack({
      "POST /subscription": () => {
        throw new Error("timeout");
      },
      "GET /subscription?customer=7&perPage=100&page=1": () => [
        { subscription_code: "SUB_other", status: "active", plan: { plan_code: "PLN_new" }, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    await expect(switchPlan()).rejects.toThrow(/nothing changed/i);
    expect(disabled()).toEqual([]);
  });

  it("does not tell the agency to re-assign when it cannot tell whether the new plan started", async () => {
    paystack({
      "POST /subscription": () => {
        throw new Error("timeout");
      },
      "GET /customer/CUS_1": () => {
        throw new Error("Paystack 503");
      },
    });
    await expect(switchPlan()).rejects.toThrow(/before re-assigning/i);
    await expect(switchPlan()).rejects.toBeInstanceOf(BillingError);
    expect(disabled()).toEqual([]);
  });

  it("undoes the new subscription when the old one cannot be disabled", async () => {
    paystack({
      "POST /subscription/disable": (body) => {
        if (body?.code === "SUB_1") throw new Error("Paystack 500");
        return {};
      },
    });
    // Both left running bills the client twice at the renewal.
    await expect(switchPlan()).rejects.toThrow(/nothing changed/i);
    expect(disabled()).toEqual(["SUB_1", "SUB_2"]);
  });

  it("treats a disable whose answer was lost as done when Paystack shows it cancelled", async () => {
    let disabledOld = false;
    paystack({
      "GET /subscription/SUB_1": () => (disabledOld ? { ...live, status: "cancelled" } : live),
      "POST /subscription/disable": () => {
        disabledOld = true;
        throw new Error("timeout");
      },
    });
    expect(await switchPlan()).toEqual({ subscriptionId: "SUB_2" });
  });

  it("names both subscriptions when it cannot undo a half-finished switch", async () => {
    paystack({
      "POST /subscription/disable": () => {
        throw new Error("Paystack 500");
      },
    });
    await expect(switchPlan()).rejects.toThrow(/SUB_1.*SUB_2/);
  });
});

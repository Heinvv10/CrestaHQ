import { beforeEach, describe, expect, it, vi } from "vitest";

import { mem } from "@/test/paystack-links-harness";

/**
 * A Paystack plan switch disables the old subscription before the new code is
 * stored, and Paystack's `subscription.disable` webhook for the old one can
 * arrive in that gap. Driven through the real assign path and the real
 * webhook router over the in-memory Firestore; the provider stands in for
 * Paystack and delivers the webhook mid-switch, as Paystack can.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const switchSubscriptionPlan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({
    id: "paystack",
    planSwitchTiming: "period_end",
    isConfigured: () => true,
    switchSubscriptionPlan,
  }),
}));

const { assignPlanToSubAccount } = await import("./billing-service");
const { handlePaystackEvent } = await import("@/lib/paystack/webhooks");

const SA = "sa1";
const billing = () => (mem.read(`subAccounts/${SA}`)?.billing ?? {}) as Record<string, unknown>;
const oldSubDisabled = () =>
  handlePaystackEvent({
    event: "subscription.disable",
    data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" } },
  });
const assign = () =>
  assignPlanToSubAccount({ agencyId: "ag1", subAccountId: SA, planId: "plan2", specialPriceCents: null });

beforeEach(() => {
  mem.clear();
  switchSubscriptionPlan.mockReset();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag1",
    name: "Client",
    billing: {
      status: "active",
      planId: "plan1",
      stripePriceId: "PLN_1",
      stripeCustomerId: "CUS_1",
      stripeSubscriptionId: "SUB_1",
      graceUntil: null,
    },
  });
  mem.seed("agencies/ag1/plans/plan2", {
    name: "Growth",
    status: "active",
    currency: "zar",
    priceMonthlyCents: 199900,
    priceAnnualCents: null,
    gates: {},
    stripeProductId: "psk_plan_plan2",
    stripePriceId: "PLN_2",
  });
});

describe("Paystack plan switch vs the old subscription's disable webhook", () => {
  it("does not cancel the workspace when the disable lands before the new code is stored", async () => {
    switchSubscriptionPlan.mockImplementation(async () => {
      await oldSubDisabled();
      return { subscriptionId: "SUB_2" };
    });

    await assign();

    expect(billing()).toMatchObject({
      status: "active",
      planId: "plan2",
      stripeSubscriptionId: "SUB_2",
      retiringSubscriptionId: null,
    });
    // ...and a redelivery after the switch is ignored as superseded.
    await oldSubDisabled();
    expect(billing().status).toBe("active");
  });

  it("lets the old subscription's events count again when the switch fails", async () => {
    switchSubscriptionPlan.mockRejectedValue(new Error("nothing changed"));
    await expect(assign()).rejects.toThrow(/nothing changed/);
    expect(billing().retiringSubscriptionId).toBeNull();

    await oldSubDisabled();
    expect(billing().status).toBe("canceled");
  });

  it("lets only one of two concurrent switches run — the other is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    switchSubscriptionPlan.mockImplementation(async () => {
      await gate;
      return { subscriptionId: "SUB_2" };
    });

    // A double-click: both read SUB_1 live before either finishes.
    const both = Promise.allSettled([assign(), assign()]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await both;

    // Two replacements for one subscription would bill the client twice.
    expect(switchSubscriptionPlan).toHaveBeenCalledTimes(1);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/already in progress/i);
    expect(billing()).toMatchObject({ stripeSubscriptionId: "SUB_2", retiringSubscriptionId: null });
  });

  it("allows a new switch once an abandoned claim has expired", async () => {
    mem.seed(`subAccounts/${SA}`, {
      agencyId: "ag1",
      billing: { ...billing(), retiringSubscriptionId: "SUB_1", retiringSince: new Date(Date.now() - 60 * 60 * 1000) },
    });
    switchSubscriptionPlan.mockResolvedValue({ subscriptionId: "SUB_2" });
    await assign();
    expect(billing().stripeSubscriptionId).toBe("SUB_2");
  });

  it("does not mute the old subscription forever if a switch died mid-way", async () => {
    mem.seed(`subAccounts/${SA}`, {
      agencyId: "ag1",
      billing: {
        ...billing(),
        retiringSubscriptionId: "SUB_1",
        retiringSince: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    await oldSubDisabled();
    expect(billing().status).toBe("canceled");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/paystack-links-harness";

/**
 * Comping a client against a Paystack plan switch, which disables the old
 * subscription and opens a NEW one (PR #413 round 2 breaker). Whichever
 * lands first, the client never ends comped while a subscription it is on
 * keeps charging: comp refuses while the switch holds its mark, writes comped
 * only if the subscription it cancelled is still on record, and the switch
 * never writes over a comped client (it cancels the new one instead). Real
 * assign + comp paths over the in-memory Firestore; the provider stands in
 * for Paystack.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const switchSubscriptionPlan = vi.hoisted(() => vi.fn());
const cancelSubscription = vi.hoisted(() => vi.fn(async (_id: string) => "cancelled"));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({ id: "paystack", planSwitchTiming: "period_end", isConfigured: () => true, switchSubscriptionPlan, cancelSubscription }),
}));

const { assignPlanToSubAccount, compSubAccount } = await import("./billing-service");
const { flushAfterResponse } = await import("@/lib/server/after-response");

const billing = () => (mem.read("subAccounts/sa1")?.billing ?? {}) as Record<string, unknown>;
const comp = () => compSubAccount({ agencyId: "ag1", subAccountId: "sa1" });
const assign = () => assignPlanToSubAccount({ agencyId: "ag1", subAccountId: "sa1", planId: "plan2", specialPriceCents: null });
const compedButBilled = () => billing().status === "comped" && typeof billing().stripeSubscriptionId === "string";
const COMPED = {
  status: "comped", planId: null, planName: null, priceCents: null, billingInterval: null, currency: null, specialPriceCents: null,
  stripePriceId: null, stripeCustomerId: "CUS_1", stripeSubscriptionId: null, checkoutTokenHash: null, graceUntil: null,
};

beforeEach(() => {
  mem.clear();
  switchSubscriptionPlan.mockReset();
  cancelSubscription.mockReset();
  cancelSubscription.mockImplementation(async () => "cancelled");
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "active", planId: "plan1", stripePriceId: "PLN_1", stripeCustomerId: "CUS_1", stripeSubscriptionId: "SUB_1", graceUntil: null } });
  mem.seed("agencies/ag1/plans/plan2", { name: "Growth", status: "active", currency: "zar", priceMonthlyCents: 199900, priceAnnualCents: null, gates: {}, stripeProductId: "psk_plan_plan2", stripePriceId: "PLN_2" });
});

describe("comp during a Paystack plan switch", () => {
  it("comp while the switch holds its mark: refused, nothing cancelled; the switch completes on SUB_2 (breaker repro)", async () => {
    let compResult: unknown;
    switchSubscriptionPlan.mockImplementation(async () => {
      compResult = await comp();
      return { subscriptionId: "SUB_2" };
    });
    await assign();
    await flushAfterResponse();
    expect(compResult).toMatchObject({ subscription: "failed", httpStatus: 409, message: expect.stringContaining("plan change is in progress") });
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(compedButBilled()).toBe(false);
    expect(billing()).toMatchObject({ status: "active", planId: "plan2", stripeSubscriptionId: "SUB_2", retiringSubscriptionId: null });
  });

  it("a switch that marks after comp cancelled: comp writes nothing (the subscription on record was never cancelled)", async () => {
    cancelSubscription.mockImplementation(async () => {
      // The switch claims its mark while Paystack is cancelling SUB_1 for the comp.
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), retiringSubscriptionId: "SUB_1", retiringSince: new Date() } });
      return "cancelled";
    });
    expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 409 });
    expect(billing().status).toBe("active");
  });

  it("a switch that replaced the subscription after comp cancelled: comp writes nothing", async () => {
    cancelSubscription.mockImplementation(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), stripeSubscriptionId: "SUB_2" } });
      return "cancelled";
    });
    expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 409 });
    expect(billing()).toMatchObject({ status: "active", stripeSubscriptionId: "SUB_2" });
  });

  it("comped while the provider switched: the switch writes nothing over it, cancels its new SUB_2 and records why", async () => {
    switchSubscriptionPlan.mockImplementation(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: COMPED });
      return { subscriptionId: "SUB_2" };
    });
    await expect(assign()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("plan change was undone") });
    await flushAfterResponse();
    expect(cancelSubscription).toHaveBeenCalledWith("SUB_2");
    expect(billing()).toMatchObject({ status: "comped", stripeSubscriptionId: null, planId: null, retiringSubscriptionId: null });
    expect(mem.list("billingEvents")).toEqual([
      expect.objectContaining({ event: "plan.switch_abandoned", detail: expect.objectContaining({ newSubscription: "SUB_2", newSubscriptionCancelled: true }) }),
    ]);
  });

  it("…and when SUB_2 won't cancel, says so by name instead of claiming nothing is billed", async () => {
    switchSubscriptionPlan.mockImplementation(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: COMPED });
      return { subscriptionId: "SUB_2" };
    });
    cancelSubscription.mockRejectedValueOnce(new Error("Paystack: down"));
    await expect(assign()).rejects.toThrow("The new subscription SUB_2 couldn't be cancelled");
    expect(billing().status).toBe("comped");
    await flushAfterResponse();
    expect(mem.list("billingEvents")[0]).toMatchObject({ detail: { newSubscriptionCancelled: false } });
  });
});

describe("comp after the provider already ended the subscription (breaker repro)", () => {
  it("a lapsed past_due client whose Paystack subscription is already disabled is comped", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "past_due", planId: "plan1", stripeSubscriptionId: "SUB_1", graceUntil: new Date(Date.now() - 86400000) } });
    cancelSubscription.mockResolvedValueOnce("already_cancelled");
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(billing()).toMatchObject({ status: "comped", stripeSubscriptionId: null });
  });
});

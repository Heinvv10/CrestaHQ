import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const cancelSubscription = vi.hoisted(() => vi.fn(async (_id: string, _customer: string | null) => "cancelled"));
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

// A billing event is written after the response: never into the next test.
afterEach(() => flushAfterResponse());

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

  it("a mark written over comp's mid-cancel (BRK r3): the subscription WAS cancelled, so the client is comped, not left active", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      // Another claim's instant, not comp's.
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), retiringSubscriptionId: "SUB_1", retiringSince: new Date(Date.now() + 5_000) } });
      return "cancelled";
    });
    const r = await comp();
    // The switch then fails (SUB_1 is gone at Paystack) and clears its mark.
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), retiringSubscriptionId: null, retiringSince: null } });
    expect(r).toEqual({ subscription: "cancelled" });
    expect(cancelSubscription).toHaveBeenCalledTimes(1);
    expect(billing().status).toBe("comped");
  });

  it("comp holds its lock across the provider call: a switch started mid-comp is refused and never reaches the provider", async () => {
    let switchError: unknown;
    cancelSubscription.mockImplementationOnce(async () => {
      expect(billing()).toMatchObject({ compingSubscriptionId: "SUB_1" });
      expect(billing().retiringSubscriptionId).toBeUndefined();
      switchError = await assign().catch((e: unknown) => e);
      return "cancelled";
    });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(switchError).toMatchObject({ status: 409, message: expect.stringContaining("being comped right now") });
    expect(switchSubscriptionPlan).not.toHaveBeenCalled();
    expect(billing()).toMatchObject({ status: "comped", stripeSubscriptionId: null });
    expect(billing().compingSubscriptionId).toBeUndefined();
  });

  it("a second comp while one holds the lock is refused before the provider", async () => {
    let second: unknown;
    cancelSubscription.mockImplementationOnce(async () => {
      second = await comp();
      return "cancelled";
    });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(second).toMatchObject({ subscription: "failed", httpStatus: 409, message: expect.stringContaining("already being comped") });
    expect(cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("the subscription's own disable webhook landing mid-comp still applies (canceled); the client ends comped", async () => {
    const { handlePaystackEvent } = await import("@/lib/paystack/webhooks");
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent({ event: "subscription.disable", data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" } } });
      expect(billing().status).toBe("canceled");
      return "cancelled";
    });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(billing().status).toBe("comped");
  });

  it("the provider refuses: the lock is released and nothing else changed", async () => {
    cancelSubscription.mockRejectedValueOnce(new Error("Paystack: down"));
    const before = JSON.stringify(billing());
    expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 502, cancelledSubscription: null, message: expect.stringContaining("nothing changed") });
    expect(billing()).toMatchObject({ compingSubscriptionId: null, compingSince: null });
    const { compingSubscriptionId: _r, compingSince: _s, ...rest } = billing();
    expect(JSON.stringify(rest)).toBe(JSON.stringify(JSON.parse(before)));
  });

  it("the provider refuses after another comp's claim took the lock: comp's release leaves that lock alone", async () => {
    const theirs = new Date(Date.now() + 5_000);
    cancelSubscription.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), compingSubscriptionId: "SUB_1", compingSince: theirs } });
      throw new Error("Paystack: down");
    });
    expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 502 });
    expect(billing()).toMatchObject({ compingSubscriptionId: "SUB_1", compingSince: theirs });
  });

  it("nothing live to cancel, but a payment activated the client between comp's read and its write: refused, never comped over it", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "pending", planId: "plan1", stripeCustomerId: "CUS_1", stripeSubscriptionId: null } });
    const original = mem.db.runTransaction.bind(mem.db);
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), status: "active", stripeSubscriptionId: "SUB_9" } });
      return original(fn as Parameters<typeof original>[0]);
    });
    try {
      expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 409, message: expect.stringContaining("billing changed") });
    } finally {
      spy.mockRestore();
    }
    expect(billing()).toMatchObject({ status: "active", stripeSubscriptionId: "SUB_9" });
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("a subscription replaced after comp cancelled (its mark expired mid-cancel): not comped, and the result says SUB_1 WAS cancelled", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), stripeSubscriptionId: "SUB_2", compingSubscriptionId: null, compingSince: null } });
      return "cancelled";
    });
    const r = await comp();
    expect(r).toMatchObject({ subscription: "failed", httpStatus: 409, cancelledSubscription: "SUB_1" });
    expect((r as { message: string }).message).toBe(
      "Cancelled subscription SUB_1 with Paystack, but the client moved to SUB_2 meanwhile, so they were NOT comped and SUB_2 still bills. Comp again to finish.",
    );
    expect(billing()).toMatchObject({ status: "active", stripeSubscriptionId: "SUB_2" });
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([
      expect.objectContaining({ event: "comp.interrupted", detail: { canceledSubscription: "SUB_1", currentSubscription: "SUB_2" } }),
    ]);
  });

  it("the comp write fails after the cancel: the result says SUB_1 WAS cancelled, the lock is released, and it is recorded", async () => {
    const original = mem.db.runTransaction.bind(mem.db);
    let n = 0;
    vi.spyOn(mem.db, "runTransaction").mockImplementation(async (fn) => {
      n += 1;
      if (n === 2) throw new Error("ABORTED: contention");
      return original(fn as Parameters<typeof original>[0]);
    });
    try {
      const r = await comp();
      expect(r).toMatchObject({ subscription: "failed", cancelledSubscription: "SUB_1", message: expect.stringContaining("Cancelled subscription SUB_1 with Paystack, but the comp couldn't be saved") });
    } finally {
      vi.mocked(mem.db.runTransaction).mockRestore();
    }
    expect(billing()).toMatchObject({ status: "active", compingSubscriptionId: null, compingSince: null });
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([expect.objectContaining({ event: "comp.interrupted" })]);
  });

  it("a crashed comp's lock expires like a switch's mark: 11 minutes on, switch and comp both proceed", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), compingSubscriptionId: "SUB_1", compingSince: new Date(Date.now() - 11 * 60_000) } });
    switchSubscriptionPlan.mockResolvedValueOnce({ subscriptionId: "SUB_2" });
    await assign();
    expect(billing()).toMatchObject({ planId: "plan2", stripeSubscriptionId: "SUB_2" });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), retiringSubscriptionId: "SUB_2", retiringSince: new Date(Date.now() - 11 * 60_000) } });
    expect(await comp()).toEqual({ subscription: "cancelled" });
  });

  it("comped while the provider switched: the switch writes nothing over it, cancels its new SUB_2 and records why", async () => {
    switchSubscriptionPlan.mockImplementation(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: COMPED });
      return { subscriptionId: "SUB_2" };
    });
    await expect(assign()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("plan change was undone") });
    await flushAfterResponse();
    expect(cancelSubscription).toHaveBeenCalledWith("SUB_2", "CUS_1");
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

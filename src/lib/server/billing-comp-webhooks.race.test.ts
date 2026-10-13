import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/paystack-links-harness";

/**
 * Comp's lock mutes nothing (PR #413 round 4 breaker). The subscription's own
 * webhooks keep applying while comp cancels it, so when comp then fails no
 * event the provider sent (and acked) is lost; and a cancel call that failed
 * is checked against the provider's record, so a cancel that landed behind a
 * timeout still finishes the comp. Real comp, lifecycle and Paystack webhook
 * router over the in-memory Firestore; the provider stands in for Paystack.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const cancelSubscription = vi.hoisted(() => vi.fn(async (_id: string, _customer: string | null) => "cancelled"));
const subscriptionEnded = vi.hoisted(() => vi.fn(async (_id: string) => false));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({ id: "paystack", planSwitchTiming: "period_end", isConfigured: () => true, cancelSubscription, subscriptionEnded }),
}));

const { compSubAccount } = await import("./billing-service");
const { applySubAccountSubscriptionStatus } = await import("./billing-lifecycle");
const { handlePaystackEvent } = await import("@/lib/paystack/webhooks");
const { flushAfterResponse } = await import("@/lib/server/after-response");

const billing = () => (mem.read("subAccounts/sa1")?.billing ?? {}) as Record<string, unknown>;
const comp = () => compSubAccount({ agencyId: "ag1", subAccountId: "sa1" });
type Event = Parameters<typeof handlePaystackEvent>[0];
const DISABLE = { event: "subscription.disable", data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" } } } as Event;
const PAYMENT_FAILED = { event: "invoice.payment_failed", data: { subscription: { subscription_code: "SUB_1" }, customer: { customer_code: "CUS_1" } } } as Event;

afterEach(() => flushAfterResponse());
beforeEach(() => {
  mem.clear();
  cancelSubscription.mockReset();
  cancelSubscription.mockImplementation(async () => "cancelled");
  subscriptionEnded.mockReset();
  subscriptionEnded.mockImplementation(async () => false);
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "active", planId: "plan1", stripePriceId: "PLN_1", stripeCustomerId: "CUS_1", stripeSubscriptionId: "SUB_1", graceUntil: null } });
});

describe("BRK r4a: Paystack disabled SUB_1 (its webhook landed mid-cancel) but the cancel call timed out", () => {
  it("the provider's record shows it ended: comp finishes, and says the subscription was cancelled", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(DISABLE);
      throw new Error("Paystack request timed out");
    });
    subscriptionEnded.mockResolvedValueOnce(true);
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(subscriptionEnded).toHaveBeenCalledWith("SUB_1");
    expect(billing()).toMatchObject({ status: "comped", stripeSubscriptionId: null });
  });

  it("the record can't be read: comp fails, but the disable webhook was applied, so the client is canceled, never active-unbilled", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(DISABLE);
      throw new Error("Paystack request timed out");
    });
    expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 502 });
    expect(billing()).toMatchObject({ status: "canceled", stripeSubscriptionId: "SUB_1", compingSubscriptionId: null });
  });
});

describe("BRK r4b: a renewal failure for SUB_1 mid-comp", () => {
  it("then comp fails: dunning has started (past_due, grace window stamped)", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(PAYMENT_FAILED);
      throw new Error("Paystack returned 500.");
    });
    expect(await comp()).toMatchObject({ subscription: "failed" });
    expect(billing().status).toBe("past_due");
    expect(billing().graceUntil).toBeTruthy();
  });

  it("then the cancel succeeds: the past_due the webhook wrote doesn't block the comp", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(PAYMENT_FAILED);
      return "cancelled";
    });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(billing().status).toBe("comped");
  });
});

it("a deleted event mid-comp (Stripe clears the id) still lets the comp finish", async () => {
  cancelSubscription.mockImplementationOnce(async () => {
    await applySubAccountSubscriptionStatus({ subscriptionId: "SUB_1", status: "canceled", deleted: true, subAccountIdHint: "sa1" });
    expect(billing()).toMatchObject({ status: "canceled", stripeSubscriptionId: null });
    return "cancelled";
  });
  expect(await comp()).toEqual({ subscription: "cancelled" });
  expect(billing().status).toBe("comped");
});

it("a client re-assigned mid-comp (pending, no subscription yet): not comped over the new assignment, and SUB_1 is reported cancelled", async () => {
  cancelSubscription.mockImplementationOnce(async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), status: "pending", planId: "plan2", stripeSubscriptionId: null } });
    return "cancelled";
  });
  expect(await comp()).toMatchObject({ subscription: "failed", cancelledSubscription: "SUB_1" });
  expect(billing()).toMatchObject({ status: "pending", planId: "plan2", compingSubscriptionId: null });
});

it("a cancel that failed on a subscription still live at the provider: nothing changed, and the provider was only read", async () => {
  cancelSubscription.mockRejectedValueOnce(new Error("Paystack returned 500."));
  expect(await comp()).toMatchObject({ subscription: "failed", message: expect.stringContaining("nothing changed") });
  expect(subscriptionEnded).toHaveBeenCalledTimes(1);
  expect(billing()).toMatchObject({ status: "active", compingSubscriptionId: null });
});

describe("BRK r4 control: the same webhooks without a comp", () => {
  it("disable → canceled; payment_failed → past_due", async () => {
    await handlePaystackEvent(PAYMENT_FAILED);
    expect(billing().status).toBe("past_due");
    await handlePaystackEvent(DISABLE);
    expect(billing().status).toBe("canceled");
  });
});

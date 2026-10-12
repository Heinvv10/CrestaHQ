import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/paystack-links-harness";

/**
 * A payment landing while comp cancels the subscription (PR #413 round 5
 * breaker), three layers deep: a payment mid-comp is flagged for a refund,
 * never applied; comp's claim closes the open checkout link (reopened if
 * the comp doesn't happen); and comp's final write refuses if the client
 * was activated since the claim anyway. Real comp, lifecycle and Paystack
 * webhook router over the in-memory Firestore; the provider and the flag
 * notifier stand in.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/server/billing-attention-notify", () => ({ notifyFlag: vi.fn(async () => {}) }));

const cancelSubscription = vi.hoisted(() => vi.fn(async (_id: string, _customer: string | null) => "cancelled"));
const subscriptionEnded = vi.hoisted(() => vi.fn(async (_id: string) => false));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({ id: "paystack", planSwitchTiming: "period_end", isConfigured: () => true, cancelSubscription, subscriptionEnded }),
}));

const { compSubAccount } = await import("./billing-service");
const { activateSubAccountPlan } = await import("./billing-lifecycle");
const { handlePaystackEvent } = await import("@/lib/paystack/webhooks");
const { flushAfterResponse } = await import("@/lib/server/after-response");

const billing = () => (mem.read("subAccounts/sa1")?.billing ?? {}) as Record<string, unknown>;
const comp = () => compSubAccount({ agencyId: "ag1", subAccountId: "sa1" });
const pay = (reference = "ref_new") =>
  activateSubAccountPlan({ subAccountId: "sa1", planId: "plan1", customerId: "CUS_1", subscriptionId: null, provider: "paystack", reference, amountCents: 9900, currency: "zar" });
const DISABLE = { event: "subscription.disable", data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" } } } as Parameters<typeof handlePaystackEvent>[0];
const ACTIVATED_AT = new Date(Date.now() - 30 * 86_400_000);

afterEach(() => flushAfterResponse());
beforeEach(() => {
  mem.clear();
  cancelSubscription.mockReset();
  cancelSubscription.mockImplementation(async () => "cancelled");
  subscriptionEnded.mockReset();
  subscriptionEnded.mockImplementation(async () => false);
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1", name: "Client",
    billing: {
      status: "past_due", planId: "plan1", stripePriceId: "PLN_1", stripeCustomerId: "CUS_1", stripeSubscriptionId: "SUB_1",
      checkoutTokenHash: "open_link", activatedAt: ACTIVATED_AT, graceUntil: new Date(Date.now() - 86_400_000),
    },
  });
});

describe("BRK r5: a new payment between comp's cancel and its final write", () => {
  it("the payment is flagged for a refund, never applied, and the comp completes over a client nobody re-activated", async () => {
    let afterPayment: unknown;
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(DISABLE);
      await pay();
      // Not re-activated: the payment is refused while comp holds its lock.
      afterPayment = billing().status;
      return "cancelled";
    });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(afterPayment).toBe("canceled");
    expect(billing().status).toBe("comped");
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "payment.flagged", detail: expect.objectContaining({ reason: "workspace is being comped", reference: "ref_new" }) }),
    ]));
  });

  it("an activation that lands anyway (activatedAt moved since the claim): not comped over it, and SUB_1 is reported cancelled", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), status: "active", activatedAt: new Date() } });
      return "cancelled";
    });
    const r = await comp();
    expect(r).toMatchObject({ subscription: "failed", httpStatus: 409, cancelledSubscription: "SUB_1", message: expect.stringContaining("paid a new checkout meanwhile") });
    expect(billing()).toMatchObject({ status: "active", compingSubscriptionId: null });
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([expect.objectContaining({ event: "comp.interrupted" })]);
  });

  it("an unchanged activatedAt (no payment) still comps", async () => {
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(billing().status).toBe("comped");
  });
});

describe("comp closes the open checkout link while it runs", () => {
  it("the claim clears it before the provider is called", async () => {
    // Read here, asserted below: an expect thrown inside the provider would read as a failed cancel.
    let duringCancel: unknown = "unread";
    cancelSubscription.mockImplementationOnce(async () => {
      duringCancel = billing().checkoutTokenHash;
      return "cancelled";
    });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(duringCancel).toBeNull();
  });

  it("a comp that fails reopens it", async () => {
    cancelSubscription.mockRejectedValueOnce(new Error("Paystack returned 500."));
    expect(await comp()).toMatchObject({ subscription: "failed" });
    expect(billing()).toMatchObject({ checkoutTokenHash: "open_link", compingSubscriptionId: null });
  });

  it("…but never over a link minted since", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), checkoutTokenHash: "newer_link" } });
      throw new Error("Paystack returned 500.");
    });
    await comp();
    expect(billing().checkoutTokenHash).toBe("newer_link");
  });
});

it("a payment outside any comp still activates (the comping check is the only new refusal)", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "pending", planId: "plan1", stripeCustomerId: "CUS_1", stripeSubscriptionId: null } });
  await pay("ref_plain");
  expect(billing().status).toBe("active");
});

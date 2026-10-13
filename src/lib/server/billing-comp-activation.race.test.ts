import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/paystack-links-harness";

/**
 * A payment landing while comp cancels the subscription (PR #413 round 5
 * breaker). The payment applies as any payment does (refusing it would leave
 * the subscription Paystack opened for it billing a comped client, with
 * nothing tracking it); comp's final write then refuses because the client
 * was activated since its claim, so the client ends active and tracked on
 * the new subscription. Comp's claim also closes the open checkout link
 * (reopened if the comp doesn't happen), so no new checkout starts mid-comp. Real comp, lifecycle and Paystack
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
  it("the payment re-activates the client, comp refuses as interrupted (SUB_1 reported cancelled), and the new subscription is tracked", async () => {
    let afterPayment: unknown;
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(DISABLE);
      await pay();
      afterPayment = billing().status;
      return "cancelled";
    });
    const r = await comp();
    expect(afterPayment).toBe("active");
    expect(r).toMatchObject({
      subscription: "failed", httpStatus: 409, cancelledSubscription: "SUB_1",
      message: expect.stringContaining("Cancelled subscription SUB_1 with Paystack, but the client paid a new checkout meanwhile"),
    });
    expect(billing()).toMatchObject({ status: "active", compingSubscriptionId: null });
    await flushAfterResponse();
    const events = mem.list("billingEvents").map((e) => e.event);
    expect(events).toContain("comp.interrupted");
    expect(events).not.toContain("payment.flagged");
    expect(events).not.toContain("comped");
    // Paystack's subscription.create for the checkout lands on the active client: tracked, cancellable.
    await handlePaystackEvent({ event: "subscription.create", data: { subscription_code: "SUB_NEW", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_1" } } } as Parameters<typeof handlePaystackEvent>[0]);
    expect(billing()).toMatchObject({ status: "active", stripeSubscriptionId: "SUB_NEW" });
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

describe("BRK r6: the checkout link isn't revived once comp is past a plain failure", () => {
  const payMidComp = (reference: string) =>
    cancelSubscription.mockImplementationOnce(async () => {
      await handlePaystackEvent(DISABLE);
      await pay(reference);
      return "cancelled";
    });

  it("a payment interrupted the comp (it consumed the link): the old link stays dead", async () => {
    payMidComp("ref_new2");
    expect(await comp()).toMatchObject({ subscription: "failed", cancelledSubscription: "SUB_1" });
    expect(billing().status).toBe("active");
    expect(billing().checkoutTokenHash ?? null).toBeNull();
  });

  it("the subscription moved on after the cancel: the old link stays dead", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), stripeSubscriptionId: "SUB_2" } });
      return "cancelled";
    });
    expect(await comp()).toMatchObject({ subscription: "failed", cancelledSubscription: "SUB_1" });
    expect(billing().checkoutTokenHash ?? null).toBeNull();
  });

  it("the cancel failed but a payment landed meanwhile: the link it consumed stays dead", async () => {
    cancelSubscription.mockImplementationOnce(async () => {
      await pay("ref_new4");
      throw new Error("Paystack returned 500.");
    });
    expect(await comp()).toMatchObject({ subscription: "failed", httpStatus: 502 });
    expect(billing().checkoutTokenHash ?? null).toBeNull();
  });

  it("BRK r6b: comping again as advised cancels the new subscription before comping", async () => {
    payMidComp("ref_new3");
    await comp();
    await handlePaystackEvent({ event: "subscription.create", data: { subscription_code: "SUB_NEW", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_1" } } } as Parameters<typeof handlePaystackEvent>[0]);
    expect(billing()).toMatchObject({ status: "active", stripeSubscriptionId: "SUB_NEW" });
    expect(await comp()).toEqual({ subscription: "cancelled" });
    expect(cancelSubscription).toHaveBeenLastCalledWith("SUB_NEW", "CUS_1");
    expect(billing().status).toBe("comped");
  });
});

it("a payment outside any comp activates as before", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "pending", planId: "plan1", stripeCustomerId: "CUS_1", stripeSubscriptionId: null } });
  await pay("ref_plain");
  expect(billing().status).toBe("active");
});

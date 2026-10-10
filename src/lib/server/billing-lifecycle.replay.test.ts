import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { mem, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * Client Billing's lifecycle under the event orders providers actually send:
 * redeliveries days later, a subscription update landing after its deletion,
 * and one Paystack customer shared by two workspaces. Driven through the real
 * lifecycle over the in-memory Firestore; only Paystack's HTTP API and the
 * gate / outbound-webhook fan-out are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
const applyFeatureGates = vi.hoisted(() => vi.fn(async () => ({ skippedMetaGates: [] })));
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates }));
const emitWebhookEvent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent }));

process.env.PAYSTACK_SECRET_KEY = "sk_test_agency";

const {
  handleSubAccountPlanCheckoutCompleted,
  handleSubAccountSubscriptionEvent,
} = await import("./billing-lifecycle");
const { handlePaystackEvent } = await import("@/lib/paystack/webhooks");

const SA = "sa1";
const PLAN = "plan1";

const billing = (sa = SA) =>
  (mem.read(`subAccounts/${sa}`)?.billing ?? {}) as Record<string, unknown>;
const events = (name: string) => mem.list("billingEvents").filter((e) => e.event === name);

function seedWorkspace(sa: string, over: Record<string, unknown> = {}) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    name: sa,
    billing: {
      status: "pending",
      planId: PLAN,
      planName: "Pro",
      priceCents: 99900,
      currency: "zar",
      stripePriceId: "PLN_pro",
      stripeCustomerId: "CUS_1",
      stripeSubscriptionId: null,
      checkoutTokenHash: "h",
      graceUntil: null,
      ...over,
    },
  });
}

const session = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    payment_status: "paid",
    customer: "CUS_1",
    subscription: "sub_1",
    amount_total: 99900,
    currency: "zar",
    metadata: { kind: "subAccountPlan", subAccountId: SA, planId: PLAN },
    ...over,
  }) as unknown as Stripe.Checkout.Session;

const stripeSub = (status: string) =>
  ({ id: "sub_1", status, metadata: { subAccountId: SA } }) as unknown as Stripe.Subscription;

const planMeta = { kind: "subAccountPlan", agencyId: "ag1", subAccountId: SA, planId: PLAN };
const paystackCharge = (reference: string) =>
  handlePaystackEvent({ event: "charge.success", data: { reference, metadata: planMeta } });

beforeEach(() => {
  mem.clear();
  applyFeatureGates.mockClear();
  emitWebhookEvent.mockClear();
  seedWorkspace(SA);
  mem.seed(`agencies/ag1/plans/${PLAN}`, { gates: { websiteEnabledByAgency: true } });
  stubPaystack((call) =>
    verified({ reference: call.path.split("/").pop()!, amount: 99900, metadata: planMeta }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("a redelivered first payment", () => {
  it("Stripe: does not revive a workspace cancelled since it was paid", async () => {
    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));
    await handleSubAccountSubscriptionEvent(stripeSub("canceled"), { deleted: true });
    expect(billing().status).toBe("canceled");

    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));

    expect(billing().status).toBe("canceled");
    // Re-applying the plan's gates would overwrite what the agency set by hand.
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(events("activated")).toHaveLength(1));
  });

  it("Paystack: does not revive a workspace cancelled since it was paid", async () => {
    await paystackCharge("ref_1");
    await handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_pro" } },
    });
    await handlePaystackEvent({
      event: "subscription.disable",
      data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" } },
    });
    expect(billing().status).toBe("canceled");

    await paystackCharge("ref_1");

    expect(billing().status).toBe("canceled");
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(events("activated")).toHaveLength(1));
  });

  it("does not activate a re-assignment of the same plan that has not been paid", async () => {
    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));
    await handleSubAccountSubscriptionEvent(stripeSub("canceled"), { deleted: true });
    // The agency re-assigns: fresh pending, a new link, nothing paid yet.
    seedWorkspace(SA);

    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));

    expect(billing().status).toBe("pending");
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
  });

  it("flags, and does not apply, a payment for a comped workspace", async () => {
    seedWorkspace(SA, { status: "comped", planId: null, stripePriceId: null });

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(billing().status).toBe("comped");
    expect(applyFeatureGates).not.toHaveBeenCalled();
    expect(events("payment.flagged")).toHaveLength(1);
    expect(events("payment.flagged")[0]).toMatchObject({
      subAccountId: SA,
      detail: expect.objectContaining({ provider: "stripe", reference: "cs_comp" }),
    });
  });

  it("flags a payment for a plan the workspace is no longer on", async () => {
    seedWorkspace(SA, { planId: "plan_other" });
    await handleSubAccountPlanCheckoutCompleted(session("cs_old_plan"));
    expect(billing().status).toBe("pending");
    expect(applyFeatureGates).not.toHaveBeenCalled();
    expect(events("payment.flagged")).toHaveLength(1);
  });

  it("flags a second, separate Stripe payment while active instead of re-activating", async () => {
    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));
    await handleSubAccountPlanCheckoutCompleted(session("cs_2", { subscription: "sub_2" }));

    // The stored subscription is still the first: repointing it would leave
    // sub_1 billing with nothing able to cancel it.
    expect(billing().stripeSubscriptionId).toBe("sub_1");
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
    expect(events("payment.flagged")).toHaveLength(1);
  });

  it("still activates a genuine re-checkout after cancellation (a new payment)", async () => {
    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));
    await handleSubAccountSubscriptionEvent(stripeSub("canceled"), { deleted: true });

    await handleSubAccountPlanCheckoutCompleted(session("cs_2", { subscription: "sub_2" }));

    expect(billing().status).toBe("active");
    expect(billing().stripeSubscriptionId).toBe("sub_2");
    expect(events("payment.flagged")).toHaveLength(0);
  });

  it("treats a pre-ledger Stripe activation's redelivery as a replay", async () => {
    // Activated before the ledger existed: the stored subscription is the record.
    seedWorkspace(SA, { status: "active", stripeSubscriptionId: "sub_1" });
    await handleSubAccountPlanCheckoutCompleted(session("cs_legacy"));
    expect(applyFeatureGates).not.toHaveBeenCalled();
    expect(billing().activatedAt).toBeUndefined();
    expect(events("payment.flagged")).toHaveLength(0);
  });

  it("treats a pre-ledger Paystack activation's redelivery as a replay", async () => {
    // Activated before the ledger existed: only billing.paystackReference records it.
    seedWorkspace(SA, { status: "canceled", paystackReference: "ref_legacy" });
    await paystackCharge("ref_legacy");
    expect(billing().status).toBe("canceled");
    expect(events("payment.flagged")).toHaveLength(0);
  });
});

describe("a subscription update arriving after its deletion", () => {
  it("does not revive the workspace", async () => {
    await handleSubAccountPlanCheckoutCompleted(session("cs_1"));
    await handleSubAccountSubscriptionEvent(stripeSub("canceled"), { deleted: true });

    await handleSubAccountSubscriptionEvent(stripeSub("active"), { deleted: false });

    expect(billing().status).toBe("canceled");
    expect(billing().stripeSubscriptionId).toBeNull();
  });
});

describe("subscription.create for a customer two workspaces share", () => {
  const create = (code: string, planCode: string) =>
    handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: code, customer: { customer_code: "CUS_1" }, plan: { plan_code: planCode } },
    });

  it("stores the code on the workspace whose plan it is, not the first match", async () => {
    // SA was stored first, so a customer-only lookup lands on it.
    seedWorkspace(SA, { status: "active", planId: "plan_basic", stripePriceId: "PLN_basic", stripeSubscriptionId: "SUB_A" });
    seedWorkspace("sa0");

    await create("SUB_B", "PLN_pro");

    expect(billing(SA).stripeSubscriptionId).toBe("SUB_A");
    expect(billing("sa0").stripeSubscriptionId).toBe("SUB_B");
  });

  it("gives the code to the workspace waiting for one, not a cancelled one on the same plan", async () => {
    seedWorkspace(SA, { status: "canceled", stripeSubscriptionId: "SUB_old" });
    seedWorkspace("sa0");

    await create("SUB_B", "PLN_pro");

    expect(billing(SA).stripeSubscriptionId).toBe("SUB_old");
    expect(billing("sa0").stripeSubscriptionId).toBe("SUB_B");
    expect(events("subscription.flagged")).toHaveLength(0);
  });

  it("writes nothing and flags it when the workspaces cannot be told apart", async () => {
    seedWorkspace("sa0");

    await create("SUB_B", "PLN_pro");

    expect(billing("sa0").stripeSubscriptionId).toBeNull();
    expect(billing(SA).stripeSubscriptionId).toBeNull();
    expect(events("subscription.flagged")).toHaveLength(1);
  });

  it("still records the code for a customer only one workspace has", async () => {
    await create("SUB_B", "PLN_pro");
    expect(billing(SA).stripeSubscriptionId).toBe("SUB_B");
  });
});

describe("activation and subscription recording — the ordinary path", () => {
  it("applies the plan's gates, clears the checkout link, and keeps a stored subscription", async () => {
    // Paystack sends the payment and the subscription separately; the payment
    // arriving second must not erase what the other event already recorded.
    seedWorkspace(SA, { stripeSubscriptionId: "SUB_1" });
    await paystackCharge("ref_1");
    expect(billing()).toMatchObject({ status: "active", checkoutTokenHash: null, stripeSubscriptionId: "SUB_1" });
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
  });

  it("records a subscription without changing status or announcing anything", async () => {
    await handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_pro" } },
    });
    // Proves a subscription exists, not that anyone paid for it.
    expect(billing()).toMatchObject({ status: "pending", stripeSubscriptionId: "SUB_1" });
    expect(emitWebhookEvent).not.toHaveBeenCalled();
  });

  it("never records a subscription on a comped workspace", async () => {
    seedWorkspace(SA, { status: "comped" });
    await handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: "SUB_1", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_pro" } },
    });
    expect(billing().stripeSubscriptionId).toBeNull();
  });
});

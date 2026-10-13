import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/paystack-links-harness";

/**
 * A comped client holds no subscription, so no subscription event may
 * change it — not a late one for the SUB_2 an abandoned plan switch opened
 * (PR #413 round 3), and not one whose read came before the comp landed.
 * The real Paystack webhook router and billing lifecycle over the in-memory
 * Firestore; the flag notifier is stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/server/billing-attention-notify", () => ({ notifyFlag: vi.fn(async () => {}) }));

const { handlePaystackEvent } = await import("@/lib/paystack/webhooks");
const { activateSubAccountPlan, applySubAccountSubscriptionStatus } = await import("./billing-lifecycle");
const { flushAfterResponse } = await import("@/lib/server/after-response");

const COMPED = { status: "comped", planId: null, stripePriceId: null, stripeCustomerId: "CUS_1", stripeSubscriptionId: null, graceUntil: null };
const billing = () => (mem.read("subAccounts/sa1")?.billing ?? {}) as Record<string, unknown>;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: COMPED });
});
afterEach(() => flushAfterResponse());

describe("a comped client ignores every subscription event", () => {
  it.each([
    ["subscription.create for SUB_2", { event: "subscription.create", data: { subscription_code: "SUB_2", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_2" } } }],
    ["subscription.disable for SUB_2", { event: "subscription.disable", data: { subscription_code: "SUB_2", customer: { customer_code: "CUS_1" } } }],
    ["a renewal charge.success on SUB_2's plan", { event: "charge.success", data: { reference: "r1", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_2" } } }],
    ["invoice.payment_failed for SUB_2", { event: "invoice.payment_failed", data: { subscription: { subscription_code: "SUB_2" }, customer: { customer_code: "CUS_1" } } }],
  ])("%s: nothing written", async (_label, event) => {
    await handlePaystackEvent(event as Parameters<typeof handlePaystackEvent>[0]);
    expect(billing()).toEqual(COMPED);
  });

  it("a late first payment for SUB_2's plan is flagged for a refund, never activated", async () => {
    await activateSubAccountPlan({
      subAccountId: "sa1", planId: "plan2", customerId: "CUS_1", subscriptionId: "SUB_2",
      provider: "paystack", reference: "ref_late", amountCents: 199900, currency: "zar",
    });
    expect(billing()).toEqual(COMPED);
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([expect.objectContaining({ event: "payment.flagged" })]);
  });
});

describe("a comp landing after an event read the client, before it wrote", () => {
  const compBeforeNextTransaction = () => {
    const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: COMPED });
      return original(fn as Parameters<typeof original>[0]);
    });
  };

  it("a status event (renewal failed → past_due) writes nothing over the comp", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { ...COMPED, status: "active", planId: "plan1", stripeSubscriptionId: "SUB_1" } });
    compBeforeNextTransaction();
    await applySubAccountSubscriptionStatus({ subscriptionId: "SUB_1", status: "past_due", deleted: false, customerIdHint: "CUS_1" });
    expect(billing()).toEqual(COMPED);
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([]);
  });

  it("subscription.create does not store SUB_2 on the now-comped client", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { ...COMPED, status: "pending", planId: "plan2", stripePriceId: "PLN_2" } });
    compBeforeNextTransaction();
    await handlePaystackEvent({ event: "subscription.create", data: { subscription_code: "SUB_2", customer: { customer_code: "CUS_1" }, plan: { plan_code: "PLN_2" } } } as Parameters<typeof handlePaystackEvent>[0]);
    expect(billing()).toEqual(COMPED);
  });
});

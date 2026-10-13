import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/paystack-links-harness";

/**
 * A Stripe plan switch has no claim transaction, so it checks comp's lock
 * on a fresh read right before the provider call — after minting a special
 * price, which can take a while (PR #413 round 5 review). A comp that
 * claimed meanwhile stops the switch before Stripe is touched.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const switchSubscriptionPlan = vi.hoisted(() => vi.fn(async () => ({ subscriptionId: "sub_1" })));
const createPrice = vi.hoisted(() => vi.fn(async () => ({ priceId: "price_special" })));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({ id: "stripe", planSwitchTiming: "immediate_prorated", isConfigured: () => true, switchSubscriptionPlan, createPrice }),
}));

const { assignPlanToSubAccount } = await import("./billing-service");

const billing = () => (mem.read("subAccounts/sa1")?.billing ?? {}) as Record<string, unknown>;
const assign = () => assignPlanToSubAccount({ agencyId: "ag1", subAccountId: "sa1", planId: "plan2", specialPriceCents: 4900 });

beforeEach(() => {
  mem.clear();
  switchSubscriptionPlan.mockClear();
  createPrice.mockReset();
  createPrice.mockImplementation(async () => ({ priceId: "price_special" }));
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client", billing: { status: "active", planId: "plan1", stripePriceId: "price_1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
  mem.seed("agencies/ag1/plans/plan2", { name: "Growth", status: "active", currency: "usd", priceMonthlyCents: 9900, priceAnnualCents: null, gates: {}, stripeProductId: "prod_2", stripePriceId: "price_2" });
});

describe("a Stripe switch against comp's lock", () => {
  it("a comp claiming while the special price is minted stops the switch before Stripe's update", async () => {
    createPrice.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...billing(), compingSubscriptionId: "sub_1", compingSince: new Date() } });
      return { priceId: "price_special" };
    });
    await expect(assign()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("being comped right now") });
    expect(switchSubscriptionPlan).not.toHaveBeenCalled();
    expect(billing()).toMatchObject({ planId: "plan1", stripePriceId: "price_1" });
  });

  it("with no comp, the switch goes through", async () => {
    await assign();
    expect(switchSubscriptionPlan).toHaveBeenCalledTimes(1);
    expect(billing()).toMatchObject({ planId: "plan2", stripePriceId: "price_special" });
  });
});

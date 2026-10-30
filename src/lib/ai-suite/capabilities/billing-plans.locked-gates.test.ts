import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Billing plans must not become a way round `assistantMayEnable: false`
 * (PR #346 review, breaker REPRO 1). Assigning a plan applies its gates
 * through `applyFeatureGates`, so `create_billing_plan` + `assign_billing_plan`
 * could switch Public API access on — and with the Agent API gate already on,
 * an agency key would reach the sub-account. Real capabilities, real
 * `assignPlanToSubAccount` and `applyFeatureGates`; only the payment provider
 * is faked.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const switchSubscriptionPlan = vi.fn(async () => ({ subscriptionId: "sub_1" }));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({
    id: "stripe",
    planSwitchTiming: "immediate_prorated",
    isConfigured: () => true,
    createPlan: async () => ({ productId: "prod_1", monthlyPriceId: "price_1", annualPriceId: null }),
    switchSubscriptionPlan,
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { PLAN_FEATURES } = await import("./billing-plan-features");
const ctx = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", agencyRole: "owner" as const };
const create = getCapability("create_billing_plan")!;
const assign = getCapability("assign_billing_plan")!;

function seedSub(apiAccess: boolean) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    name: "Velocity",
    apiAccessEnabledByAgency: apiAccess,
    agentApiEnabledByAgency: true,
    broadcastsEnabledByAgency: false,
    billing: { status: "active", planId: "plan_old", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" },
  });
}

/** Creates a plan through the capability (validate skipped) and assigns it. */
async function createThenAssign(raw: Record<string, unknown>) {
  const created = await create.execute(ctx, { name: "Pro", priceMonthlyCents: 9900, priceAnnualCents: null, currency: "usd", features: [], ...raw });
  const planId = (created.ref as { id: string }).id;
  await assign.execute(ctx, { subAccountId: "sa1", subAccountName: "Velocity", planId, planName: "Pro", interval: "month", specialPriceCents: null });
  return planId;
}

beforeEach(() => {
  mem.clear();
  switchSubscriptionPlan.mockClear();
  seedSub(false);
});

describe("create_billing_plan never bundles an assistant-locked gate", () => {
  it("does not offer api-access", () => {
    expect(PLAN_FEATURES).not.toContain("api-access");
    expect(PLAN_FEATURES).toContain("broadcasts");
  });

  it("validate refuses features:[api-access]", () => {
    const v = create.validate({ name: "Pro", priceMonthly: 99, features: ["api-access"] });
    expect(v).toMatchObject({ ok: false, error: expect.stringMatching(/only be added to a plan by the agency owner/) });
  });

  it("features:[api-access] then assign leaves Public API access off (validate skipped)", async () => {
    const planId = await createThenAssign({ features: ["api-access", "broadcasts"] });
    expect(mem.read(`agencies/ag1/plans/${planId}`)?.gates).toMatchObject({ apiAccessEnabledByAgency: false, broadcastsEnabledByAgency: true });
    const sa = mem.read("subAccounts/sa1");
    expect(sa?.broadcastsEnabledByAgency).toBe(true); // the plan's gates really were applied
    expect(sa?.apiAccessEnabledByAgency).toBe(false);
  });

  it("includeAllFeatures then assign leaves Public API access off", async () => {
    const planId = await createThenAssign({ includeAllFeatures: true });
    expect(mem.read(`agencies/ag1/plans/${planId}`)?.gates).toMatchObject({ apiAccessEnabledByAgency: false, broadcastsEnabledByAgency: true });
    const sa = mem.read("subAccounts/sa1");
    expect(sa?.broadcastsEnabledByAgency).toBe(true);
    expect(sa?.apiAccessEnabledByAgency).toBe(false);
  });
});

describe("assign_billing_plan refuses a plan that would switch a locked gate on", () => {
  // A plan the owner built by hand in the billing UI may sell API access.
  const ownerPlan = { name: "API", status: "active", currency: "usd", priceMonthlyCents: 9900, priceAnnualCents: null, stripeProductId: "prod_1", stripePriceId: "price_1", gates: { apiAccessEnabledByAgency: true, broadcastsEnabledByAgency: true } };
  const args = { subAccountId: "sa1", subAccountName: "Velocity", planId: "plan_api", planName: "API", interval: "month", specialPriceCents: null };

  it("refuses when the gate is off on the target, and changes nothing", async () => {
    mem.seed("agencies/ag1/plans/plan_api", ownerPlan);
    await expect(assign.execute(ctx, args)).rejects.toThrow(/would switch on Public API access/);
    expect(switchSubscriptionPlan).not.toHaveBeenCalled();
    const sa = mem.read("subAccounts/sa1");
    expect(sa?.apiAccessEnabledByAgency).toBe(false);
    expect(sa?.broadcastsEnabledByAgency).toBe(false);
  });

  it("never reads another agency's sub-account gates: it answers not-found", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag2", apiAccessEnabledByAgency: false });
    mem.seed("agencies/ag1/plans/plan_api", ownerPlan);
    await expect(assign.execute(ctx, args)).rejects.toThrow("Sub-account not found");
  });

  it("refuses on the pending (checkout) path even when the gate is on now", async () => {
    // Fix-review REPRO 1: assign while on, switch it off, the client pays,
    // activation switches it back on. Without a live subscription the plan is
    // judged as if every gate were off.
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
    mem.seed("agencies/ag1/plans/plan_api", ownerPlan);
    await expect(assign.execute(ctx, args)).rejects.toThrow(/would switch on Public API access/);
    expect(mem.read("subAccounts/sa1")?.billing).toBeUndefined();
  });

  it("refuses after a cancelled subscription too (re-assignment is a checkout)", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity", apiAccessEnabledByAgency: true, billing: { status: "canceled", stripeSubscriptionId: "sub_1" } });
    mem.seed("agencies/ag1/plans/plan_api", ownerPlan);
    await expect(assign.execute(ctx, args)).rejects.toThrow(/would switch on Public API access/);
  });

  it("allows it when the gate is already on (nothing is switched on)", async () => {
    seedSub(true);
    mem.seed("agencies/ag1/plans/plan_api", ownerPlan);
    await assign.execute(ctx, args);
    expect(mem.read("subAccounts/sa1")?.broadcastsEnabledByAgency).toBe(true);
  });
});

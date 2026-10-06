import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { PLAN_GATE_KEYS } from "@/types/billing";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";

/**
 * `assignPlanToSubAccount`'s expected-price pin (AGENCY_AGENT_API_PLAN.md D4,
 * REVISED r3 P2-3 corrected for A4b): an approved agent proposal passes the
 * price and gates the owner reviewed, and the service refuses
 * `pinned_mismatch` at its OWN plan read, before any provider call or write —
 * so a plan edited after the approve claim can never be the one that bills.
 * The owner UI passes neither and is unchanged. Real service, real provider
 * selection with every provider method spied, in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { assignPlanToSubAccount } = await import("./billing-service");

restoreBillingProviderAfterEach();

const GATES = { broadcastsEnabledByAgency: true, labsEnabledByAgency: false };
const PLAN = {
  name: "Pro", status: "active", currency: "zar", priceMonthlyCents: 9900, priceAnnualCents: 99000,
  stripeProductId: "prod_1", stripePriceId: "price_m", stripeAnnualPriceId: "price_y", gates: GATES,
};
const LIVE = { status: "active", planId: "plan_old", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" };
/** The plan's gates as the preview pins them: every plan gate, true or false. */
const pinnedGates = () => Object.fromEntries(PLAN_GATE_KEYS.map((k) => [k, (GATES as Record<string, boolean>)[k] === true]));
const assign = (extra: Record<string, unknown> = {}) =>
  assignPlanToSubAccount({ agencyId: "ag1", subAccountId: "sa1", planId: "plan_1", specialPriceCents: null, ...extra });

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1/plans/plan_1", PLAN);
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client One", broadcastsEnabledByAgency: false, billing: LIVE });
});

describe.each(["stripe", "paystack"] as const)("on %s", (kind) => {
  it("the reviewed price and gates → switches once", async () => {
    const spies = spyBillingProvider(kind);
    await assign({ expectedPriceCents: 9900, expectedGates: pinnedGates() });
    expect(spies.switchSubscriptionPlan).toHaveBeenCalledTimes(1);
    expect(mem.read("subAccounts/sa1")?.billing).toMatchObject({ planId: "plan_1", priceCents: 9900, specialPriceCents: null });
  });

  it("yearly: the reviewed annual price → switches once", async () => {
    const spies = spyBillingProvider(kind);
    await assign({ interval: "year", expectedPriceCents: 99000, expectedGates: pinnedGates() });
    expect(spies.switchSubscriptionPlan).toHaveBeenCalledTimes(1);
    expect(mem.read("subAccounts/sa1")?.billing).toMatchObject({ priceCents: 99000, billingInterval: "year" });
  });

  it.each([
    ["the monthly price", { priceMonthlyCents: 12900 }, {}],
    ["a gate switched on", { gates: { ...GATES, labsEnabledByAgency: true } }, {}],
    ["a gate switched off", { gates: { ...GATES, broadcastsEnabledByAgency: false } }, {}],
    ["a gate added", { gates: { ...GATES, apiAccessEnabledByAgency: true } }, {}],
    ["the annual price, assigned yearly", { priceAnnualCents: 89000 }, { interval: "year", expectedPriceCents: 99000 }],
  ])("%s edited since it was reviewed → pinned_mismatch, no provider call, nothing written", async (_label, edit, extra) => {
    const spies = spyBillingProvider(kind);
    mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, ...edit });
    await expect(assign({ expectedPriceCents: 9900, expectedGates: pinnedGates(), ...extra })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/^pinned_mismatch/),
    });
    expect(spies.calls()).toBe(0);
    expect(mem.read("subAccounts/sa1")).toMatchObject({ billing: LIVE, broadcastsEnabledByAgency: false });
  });

  it("the owner UI passes no pin: an edited plan still assigns (unchanged)", async () => {
    const spies = spyBillingProvider(kind);
    mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, priceMonthlyCents: 12900 });
    await assign();
    expect(spies.switchSubscriptionPlan).toHaveBeenCalledTimes(1);
  });
});

it("the pending (checkout) path refuses an edited plan too, before writing the billing doc", async () => {
  spyBillingProvider("stripe");
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client One" });
  mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, priceMonthlyCents: 12900 });
  await expect(assign({ expectedPriceCents: 9900, expectedGates: pinnedGates() })).rejects.toMatchObject({ status: 409 });
  expect(mem.read("subAccounts/sa1")?.billing).toBeUndefined();
});

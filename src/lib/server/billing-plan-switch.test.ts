import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plan switch on a LIVE subscription — the one path in Client Billing that
 * changes what a client's card is charged while it is already being charged.
 *
 * Both guards here are provider-shaped, so neither is visible from an adapter
 * test: the timing must come from the provider (Stripe prorates, Paystack
 * cannot), and the subscription id the provider hands back must be persisted
 * (Stripe returns the same one, Paystack a new one).
 */

const AG = "ag_1";
const SA = "sa_1";

const updates: Record<string, unknown>[] = [];
const switchSubscriptionPlan = vi.fn();
const createPrice = vi.fn();

let subDoc: Record<string, unknown>;
let planDoc: Record<string, unknown>;

const provider = {
  id: "stripe" as string,
  planSwitchTiming: "immediate_prorated" as string,
  isConfigured: () => true,
  switchSubscriptionPlan: (...a: unknown[]) => switchSubscriptionPlan(...a),
  createPrice: (...a: unknown[]) => createPrice(...a),
};

vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => provider,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    // The Paystack switch claims its lock in a transaction; one pass here.
    runTransaction: async <T,>(
      fn: (tx: {
        get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
        update: (_ref: unknown, patch: Record<string, unknown>) => void;
      }) => Promise<T>,
    ) =>
      fn({
        get: (ref) => ref.get(),
        update: (_ref, patch) => void updates.push(patch),
      }),
    doc: (path: string) => ({
      get: async () => ({ exists: true, data: () => subDoc, id: path }),
      update: async (patch: Record<string, unknown>) => {
        updates.push(patch);
      },
    }),
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: true, data: () => planDoc, id }),
      }),
      add: async () => ({ id: "evt_1" }),
    }),
  }),
}));
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: vi.fn(async () => {}),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: vi.fn(async () => {}),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

const { assignPlanToSubAccount } = await import("./billing-service");

function assign() {
  return assignPlanToSubAccount({
    agencyId: AG,
    subAccountId: SA,
    planId: "plan_2",
    specialPriceCents: null,
  });
}

/** The single `billing.*` patch written by the switch branch. */
function patch() {
  const written = updates.find((u) => "billing.planId" in u);
  if (!written) throw new Error("no billing update was written");
  return written;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_1";
  provider.id = "stripe";
  provider.planSwitchTiming = "immediate_prorated";
  switchSubscriptionPlan.mockResolvedValue({ subscriptionId: "sub_1" });
  planDoc = {
    id: "plan_2",
    name: "Growth",
    status: "active",
    currency: "zar",
    priceMonthlyCents: 99000,
    priceAnnualCents: null,
    gates: {},
    stripeProductId: "prod_1",
    stripePriceId: "price_2",
  };
  subDoc = {
    agencyId: AG,
    name: "Acme",
    billing: {
      status: "active",
      planId: "plan_1",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
    },
  };
});

describe("assignPlanToSubAccount — switching a live subscription", () => {
  it("asks the provider for a timing it can honour, rather than assuming proration", async () => {
    provider.id = "paystack";
    provider.planSwitchTiming = "period_end";
    switchSubscriptionPlan.mockResolvedValue({ subscriptionId: "SUB_2" });

    await assign();

    // Paystack refuses `immediate_prorated` outright, so a hard-coded timing
    // here makes every plan switch on that rail fail.
    expect(switchSubscriptionPlan).toHaveBeenCalledWith(
      expect.objectContaining({ timing: "period_end" }),
    );
  });

  it("still prorates on Stripe", async () => {
    await assign();
    expect(switchSubscriptionPlan).toHaveBeenCalledWith(
      expect.objectContaining({ timing: "immediate_prorated" }),
    );
  });

  it("stores the subscription that is live after the switch, not the one sent in", async () => {
    provider.id = "paystack";
    provider.planSwitchTiming = "period_end";
    // Paystack cannot move a subscription between plans: it cancels SUB_1 and
    // opens SUB_2. Keeping SUB_1 means a later cancel disables a dead
    // subscription while SUB_2 keeps debiting the client every month.
    switchSubscriptionPlan.mockResolvedValue({ subscriptionId: "SUB_2" });

    await assign();

    expect(patch()["billing.stripeSubscriptionId"]).toBe("SUB_2");
  });

  it("leaves the stored id alone when the provider hands back the same one", async () => {
    await assign();
    expect(patch()["billing.stripeSubscriptionId"]).toBe("sub_1");
  });

  it("does not write the plan change when the switch fails", async () => {
    switchSubscriptionPlan.mockRejectedValue(new Error("provider refused"));
    await expect(assign()).rejects.toThrow(/provider refused/);
    // Firestore claiming the new plan while the provider still bills the old
    // one is worse than the failure itself.
    expect(updates.some((u) => "billing.planId" in u)).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Activation and charge-payment — the two writes that decide whether a client
 * gets what they paid for, and the two most likely to be delivered twice.
 *
 * The Paystack endpoint returns 500 on any handler error so the provider
 * retries, which makes redelivery routine rather than exceptional. Everything
 * here has to hold on the second and third delivery of the same event.
 */

const updates: Record<string, unknown>[] = [];
const applyFeatureGates = vi.fn(async () => ({ skippedMetaGates: [] }));
const emitWebhookEvent = vi.fn(async () => {});
const added: Record<string, unknown>[] = [];

let subDoc: Record<string, unknown> | null;
let planDoc: Record<string, unknown> | null;
let chargeDoc: Record<string, unknown> | null;

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    // markSubAccountChargePaid is a compare-and-set; one pass is enough here.
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
      get: async () => ({
        exists: path.startsWith("agencies/") ? !!planDoc : !!subDoc,
        data: () => (path.startsWith("agencies/") ? planDoc : subDoc),
      }),
      update: async (patch: Record<string, unknown>) => {
        updates.push(patch);
      },
    }),
    collection: (name: string) => ({
      doc: () => ({
        get: async () => ({ exists: !!chargeDoc, data: () => chargeDoc }),
        update: async (patch: Record<string, unknown>) => {
          updates.push(patch);
        },
      }),
      where: () => ({
        limit: () => ({
          get: async () => ({
            empty: !subDoc,
            docs: subDoc ? [{ id: "sa_1" }] : [],
          }),
        }),
      }),
      add: async (row: Record<string, unknown>) => {
        if (name === "billingEvents") added.push(row);
        return { id: "evt_1" };
      },
    }),
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: (...a: unknown[]) => emitWebhookEvent(...(a as [])),
}));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({ id: "paystack", isConfigured: () => true }),
}));
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: (...a: unknown[]) => applyFeatureGates(...(a as [])),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromMillis: (ms: number) => ({ ms }) },
}));

const {
  activateSubAccountPlan,
  markSubAccountChargePaid,
  recordSubAccountSubscriptionId,
} = await import("./billing-service");

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  added.length = 0;
  planDoc = { gates: { websiteEnabledByAgency: true } };
  chargeDoc = null;
  subDoc = {
    agencyId: "ag_1",
    billing: {
      status: "pending",
      planId: "plan_1",
      stripeCustomerId: "CUS_1",
    },
  };
});

describe("activateSubAccountPlan", () => {
  it("applies the plan's gates and clears the checkout link", async () => {
    await activateSubAccountPlan({
      subAccountId: "sa_1",
      planId: "plan_1",
      customerId: "CUS_1",
      subscriptionId: null,
    });
    expect(applyFeatureGates).toHaveBeenCalled();
    expect(updates[0]["billing.status"]).toBe("active");
    expect(updates[0]["billing.checkoutTokenHash"]).toBeNull();
  });

  it("does not clear a stored subscription id when the event names none", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: {
        status: "pending",
        planId: "plan_1",
        stripeSubscriptionId: "SUB_1",
      },
    };
    await activateSubAccountPlan({
      subAccountId: "sa_1",
      planId: "plan_1",
      customerId: "CUS_1",
      subscriptionId: null,
    });
    // Paystack sends the payment and the subscription separately; the payment
    // arriving second must not erase what the other event already recorded.
    expect(updates[0]["billing.stripeSubscriptionId"]).toBe("SUB_1");
  });

  it("ignores a redelivered activation for a plan the client has since left", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: { status: "active", planId: "plan_2" },
    };
    await activateSubAccountPlan({
      subAccountId: "sa_1",
      planId: "plan_1",
      customerId: "CUS_1",
      subscriptionId: null,
    });
    // Re-running plan 1's gate bundle on a plan 2 workspace silently restores
    // features the client no longer pays for, and the doc still says plan 2.
    expect(updates).toHaveLength(0);
    expect(applyFeatureGates).not.toHaveBeenCalled();
  });

  it("still re-applies gates on a redelivery of the CURRENT plan", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: { status: "active", planId: "plan_1" },
    };
    await activateSubAccountPlan({
      subAccountId: "sa_1",
      planId: "plan_1",
      customerId: "CUS_1",
      subscriptionId: null,
    });
    expect(applyFeatureGates).toHaveBeenCalled();
  });
});

describe("recordSubAccountSubscriptionId", () => {
  it("writes the id and changes no status", async () => {
    await recordSubAccountSubscriptionId({
      customerId: "CUS_1",
      subscriptionId: "SUB_1",
    });
    expect(updates[0]).toMatchObject({
      "billing.stripeSubscriptionId": "SUB_1",
    });
    // A pending workspace must stay pending: this event proves a subscription
    // exists, not that anyone paid for it.
    expect(updates[0]).not.toHaveProperty("billing.status");
    expect(emitWebhookEvent).not.toHaveBeenCalled();
  });

  it("never touches a comped workspace", async () => {
    subDoc = { agencyId: "ag_1", billing: { status: "comped" } };
    await recordSubAccountSubscriptionId({
      customerId: "CUS_1",
      subscriptionId: "SUB_1",
    });
    expect(updates).toHaveLength(0);
  });

  it("writes nothing when the id is already recorded", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: { status: "active", stripeSubscriptionId: "SUB_1" },
    };
    await recordSubAccountSubscriptionId({
      customerId: "CUS_1",
      subscriptionId: "SUB_1",
    });
    expect(updates).toHaveLength(0);
  });
});

describe("markSubAccountChargePaid", () => {
  it("is idempotent — a redelivery marks nothing twice", async () => {
    chargeDoc = { status: "paid", agencyId: "ag_1", subAccountId: "sa_1" };
    await markSubAccountChargePaid({
      chargeId: "ch_1",
      checkoutSessionId: "ref_1",
      paymentId: "1",
    });
    expect(updates).toHaveLength(0);
  });

  it("records a canceled charge that was paid anyway, and flags it", async () => {
    chargeDoc = {
      status: "canceled",
      agencyId: "ag_1",
      subAccountId: "sa_1",
      description: "Web design",
      amountCents: 50000,
      currency: "zar",
    };
    await markSubAccountChargePaid({
      chargeId: "ch_1",
      checkoutSessionId: "ref_1",
      paymentId: "1",
    });
    // The money is real, so dropping it is not an option — but the agency
    // believes this charge is void and has to be told to refund it.
    expect(updates[0].status).toBe("paid");
    expect(added[0]?.detail).toMatchObject({ paidAfterCancel: true });
  });
});

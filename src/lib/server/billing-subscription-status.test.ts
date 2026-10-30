import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared subscription-status handler. Both rails land here, so every guard
 * below protects Stripe and Paystack at once — and a Paystack renewal, which
 * names only a customer, exercises paths Stripe never did.
 */

const updates: Record<string, unknown>[] = [];
let subDoc: Record<string, unknown> | null;
let queried: { field: string; value: string }[] = [];

const subRef = {
  get: async () => ({ exists: !!subDoc, data: () => subDoc }),
  update: async (patch: Record<string, unknown>) => {
    updates.push(patch);
  },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => subRef,
    // The write re-reads in a transaction (a comped client takes no event).
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({ get: (ref: typeof subRef) => ref.get(), update: (ref: typeof subRef, patch: Record<string, unknown>) => void ref.update(patch) }),
    collection: (name: string) => ({
      where: (field: string, _op: string, value: string) => {
        if (name === "subAccounts") queried.push({ field, value });
        return {
          limit: () => ({
            get: async () => ({
              empty: !subDoc,
              docs: subDoc ? [{ id: "sa_1" }] : [],
            }),
          }),
        };
      },
      add: async () => ({ id: "evt_1" }),
    }),
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/billing/provider", () => ({
  getBillingProvider: () => ({ id: "paystack", isConfigured: () => true }),
}));
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromMillis: (ms: number) => ({ ms }) },
}));

const { applySubAccountSubscriptionStatus } = await import("./billing-service");

function patch() {
  const written = updates[0];
  if (!written) throw new Error("nothing was written");
  return written;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  queried = [];
  subDoc = {
    agencyId: "ag_1",
    billing: {
      status: "active",
      planId: "plan_1",
      stripeSubscriptionId: "SUB_1",
      stripeCustomerId: "CUS_1",
    },
  };
});

describe("identifying the workspace", () => {
  it("falls back to the customer when the event names no subscription", async () => {
    await applySubAccountSubscriptionStatus({
      subscriptionId: null,
      status: "active",
      deleted: false,
      customerIdHint: "CUS_1",
    });
    // A Paystack renewal names only the customer. Without this lookup a paying
    // client stays on the dunning banner forever.
    expect(queried).toContainEqual({
      field: "billing.stripeCustomerId",
      value: "CUS_1",
    });
  });

  it("writes nothing when neither hint resolves a workspace", async () => {
    subDoc = null;
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_x",
      status: "canceled",
      deleted: false,
    });
    expect(updates).toHaveLength(0);
  });
});

describe("guarding the stored subscription id", () => {
  it("leaves the stored id alone when the event named none", async () => {
    await applySubAccountSubscriptionStatus({
      subscriptionId: null,
      status: "active",
      deleted: false,
      customerIdHint: "CUS_1",
    });
    // Writing null here would strand the workspace with no way to cancel it.
    expect(patch()).not.toHaveProperty("billing.stripeSubscriptionId");
  });

  it("ignores an event from a superseded subscription", async () => {
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_old",
      status: "canceled",
      deleted: false,
    });
    // The old subscription's cancellation arriving after a re-checkout must
    // not cancel the workspace that just paid.
    expect(updates).toHaveLength(0);
  });

  it("clears the id only on an explicit delete", async () => {
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: "canceled",
      deleted: true,
    });
    expect(patch()["billing.stripeSubscriptionId"]).toBeNull();
  });
});

describe("status transitions", () => {
  it("leaves the client's status alone for a status it cannot map", async () => {
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: null,
      deleted: false,
    });
    // An unmapped provider status is not evidence of anything. Guessing one
    // moves a paying client into dunning.
    expect(patch()).not.toHaveProperty("billing.status");
  });

  it("never touches a comped workspace", async () => {
    subDoc = { agencyId: "ag_1", billing: { status: "comped" } };
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: "canceled",
      deleted: false,
      subAccountIdHint: "sa_1",
    });
    expect(updates).toHaveLength(0);
  });

  it("ignores subscription noise while the client has never paid", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: { status: "pending", stripeSubscriptionId: null },
    };
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: "past_due",
      deleted: false,
      subAccountIdHint: "sa_1",
    });
    // Half-finished checkouts emit failure noise; it must not put a
    // never-activated workspace into dunning.
    expect(updates).toHaveLength(0);
  });

  it("stamps the grace window once per dunning episode", async () => {
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: "past_due",
      deleted: false,
    });
    expect(patch()["billing.graceUntil"]).toBeTruthy();

    updates.length = 0;
    subDoc = {
      agencyId: "ag_1",
      billing: {
        status: "past_due",
        graceUntil: { ms: 1 },
        stripeSubscriptionId: "SUB_1",
      },
    };
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: "past_due",
      deleted: false,
    });
    // Provider retries must not keep pushing the paywall out.
    expect(patch()).not.toHaveProperty("billing.graceUntil");
  });

  it("clears the grace window when the client pays", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: {
        status: "past_due",
        graceUntil: { ms: 1 },
        stripeSubscriptionId: "SUB_1",
      },
    };
    await applySubAccountSubscriptionStatus({
      subscriptionId: "SUB_1",
      status: "active",
      deleted: false,
    });
    expect(patch()["billing.graceUntil"]).toBeNull();
    expect(patch()["billing.status"]).toBe("active");
  });
});

describe("evidence that the event is about this workspace's plan", () => {
  it("ignores a payment on a plan the workspace is not subscribed to", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: {
        status: "past_due",
        graceUntil: { ms: 1 },
        stripePriceId: "PLN_growth",
        stripeCustomerId: "CUS_1",
      },
    };
    await applySubAccountSubscriptionStatus({
      subscriptionId: null,
      status: "active",
      deleted: false,
      customerIdHint: "CUS_1",
      matchPriceId: "PLN_something_else",
    });
    // Matching on customer alone would let any other payment by the same
    // person clear their dunning window and unlock an unpaid plan.
    expect(updates).toHaveLength(0);
  });

  it("accepts a payment on the plan the workspace IS subscribed to", async () => {
    subDoc = {
      agencyId: "ag_1",
      billing: {
        status: "past_due",
        graceUntil: { ms: 1 },
        stripePriceId: "PLN_growth",
        stripeCustomerId: "CUS_1",
      },
    };
    await applySubAccountSubscriptionStatus({
      subscriptionId: null,
      status: "active",
      deleted: false,
      customerIdHint: "CUS_1",
      matchPriceId: "PLN_growth",
    });
    expect(patch()["billing.status"]).toBe("active");
    expect(patch()["billing.graceUntil"]).toBeNull();
  });
});

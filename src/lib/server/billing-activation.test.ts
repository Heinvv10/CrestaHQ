import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Charge payment — a write that decides whether a client gets what they paid
 * for, and one of the most likely to be delivered twice.
 *
 * The Paystack endpoint returns 500 on any handler error so the provider
 * retries, which makes redelivery routine rather than exceptional. Everything
 * here has to hold on the second and third delivery of the same event.
 *
 * Plan activation's redelivery cases run over the in-memory Firestore in
 * `billing-lifecycle.replay.test.ts`.
 */

const updates: Record<string, unknown>[] = [];
const emitWebhookEvent = vi.fn(async () => {});
const added: Record<string, unknown>[] = [];

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
    collection: (name: string) => ({
      doc: () => ({
        get: async () => ({ exists: !!chargeDoc, data: () => chargeDoc }),
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
  applyFeatureGates: vi.fn(),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromMillis: (ms: number) => ({ ms }) },
}));

const { markSubAccountChargePaid } = await import("./billing-service");

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  added.length = 0;
  chargeDoc = null;
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
    await vi.waitFor(() => expect(added[0]?.detail).toMatchObject({ paidAfterCancel: true }));
  });
});

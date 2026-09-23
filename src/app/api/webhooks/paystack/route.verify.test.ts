import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mem, stubPaystack, verified, type PaystackCall } from "@/test/paystack-links-harness";

/**
 * Client Billing's AGENCY-level Paystack webhook, driven through the real
 * route and the real billing lifecycle over the in-memory Firestore. Only
 * Paystack's HTTP API (and the gate/outbound-webhook fan-out) is stubbed.
 *
 * A signed `charge.success` proves Paystack saw a payment on the agency's
 * account — not that the payment was for the plan or charge its metadata
 * names. Metadata and amount are payer-controlled at checkout, so nothing is
 * activated or marked paid until Paystack's verify endpoint confirms the
 * money matches what is owed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
const applyFeatureGates = vi.hoisted(() => vi.fn(async () => ({ skippedMetaGates: [] })));
vi.mock("@/lib/server/feature-gates-service", () => ({ applyFeatureGates }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const AGENCY_KEY = "sk_test_agency";
process.env.PAYSTACK_SECRET_KEY = AGENCY_KEY;

const { POST } = await import("./route");

const SA = "sa1";
const PLAN = "plan1";
const CHARGE = "ch1";

function deliver(data: Record<string, unknown>) {
  const raw = JSON.stringify({ event: "charge.success", data });
  const sig = createHmac("sha512", AGENCY_KEY).update(raw).digest("hex");
  return POST(
    new Request("https://crm.example.com/api/webhooks/paystack", {
      method: "POST",
      headers: { "x-paystack-signature": sig },
      body: raw,
    }),
  );
}

const planMeta = { kind: "subAccountPlan", agencyId: "ag1", subAccountId: SA, planId: PLAN };
const chargeMeta = { kind: "subAccountCharge", agencyId: "ag1", subAccountId: SA, chargeId: CHARGE };

/** What Paystack's verify endpoint says about each reference. */
let verifyAs: (call: PaystackCall) => { status?: number; body: unknown } | "network-error";
let calls: PaystackCall[];

const billing = () =>
  (mem.read(`subAccounts/${SA}`)?.billing ?? {}) as Record<string, unknown>;
const charge = () => mem.read(`billingCharges/${CHARGE}`) ?? {};
const flags = () =>
  mem.list("billingEvents").filter((e) => e.event === "payment.flagged");

beforeEach(() => {
  mem.clear();
  applyFeatureGates.mockClear();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag1",
    name: "Client",
    billing: {
      status: "pending",
      planId: PLAN,
      planName: "Pro",
      priceCents: 99900,
      currency: "zar",
      stripeCustomerId: "CUS_1",
      stripeSubscriptionId: null,
      checkoutTokenHash: "h",
      graceUntil: null,
    },
  });
  mem.seed(`agencies/ag1/plans/${PLAN}`, { gates: { websiteEnabledByAgency: true } });
  mem.seed(`billingCharges/${CHARGE}`, {
    agencyId: "ag1",
    subAccountId: SA,
    description: "Web design",
    amountCents: 500000,
    currency: "zar",
    status: "pending",
    tokenHash: "t",
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
  });
  verifyAs = (call) =>
    verified({ reference: call.path.split("/").pop()!, amount: 99900, metadata: planMeta });
  calls = stubPaystack((call) => verifyAs(call));
});

afterEach(() => vi.unstubAllGlobals());

describe("plan payment", () => {
  it("does not activate a plan paid R1 under forged metadata, and flags it for the agency", async () => {
    verifyAs = () => verified({ reference: "ref_forged", amount: 100, metadata: planMeta });
    const res = await deliver({ reference: "ref_forged", amount: 99900, metadata: planMeta });

    // Deterministic: a redelivery would find the same mismatch.
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
    expect(applyFeatureGates).not.toHaveBeenCalled();
    expect(flags()).toHaveLength(1);
    expect(flags()[0]).toMatchObject({ agencyId: "ag1", subAccountId: SA });
  });

  it("acts on Paystack's verified record, not the webhook body", async () => {
    // The body claims full price; Paystack says R1 was paid.
    verifyAs = () => verified({ reference: "ref_body", amount: 100, metadata: planMeta });
    await deliver({ reference: "ref_body", amount: 99900, metadata: planMeta });
    expect(calls.map((c) => c.path)).toEqual(["/transaction/verify/ref_body"]);
    // Verified with the agency's own key.
    expect(calls[0].auth).toBe(`Bearer ${AGENCY_KEY}`);
    expect(billing().status).toBe("pending");
  });

  it("does not activate when the currency is not the plan's", async () => {
    verifyAs = () =>
      verified({ reference: "ref_ngn", amount: 99900, currency: "NGN", metadata: planMeta });
    const res = await deliver({ reference: "ref_ngn", metadata: planMeta });
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
    expect(flags()).toHaveLength(1);
  });

  it("does not activate a plan the workspace was never assigned", async () => {
    const meta = { ...planMeta, planId: "plan_top" };
    verifyAs = () => verified({ reference: "ref_top", amount: 99900, metadata: meta });
    const res = await deliver({ reference: "ref_top", metadata: meta });
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
    expect(billing().planId).toBe(PLAN);
    expect(flags()).toHaveLength(1);
  });

  it("activates on the correct amount, once — a replay changes nothing", async () => {
    const first = await deliver({ reference: "ref_ok", metadata: planMeta });
    expect(first.status).toBe(200);
    expect(billing().status).toBe("active");
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);

    const replay = await deliver({ reference: "ref_ok", metadata: planMeta });
    expect(replay.status).toBe(200);
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
    expect(mem.list("billingEvents").filter((e) => e.event === "activated")).toHaveLength(1);
    expect(flags()).toHaveLength(0);
  });

  it("answers 5xx when Paystack cannot be reached, so the event is redelivered", async () => {
    verifyAs = () => "network-error";
    const res = await deliver({ reference: "ref_down", metadata: planMeta });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(billing().status).toBe("pending");
    expect(flags()).toHaveLength(0);
  });

  it("answers 5xx when Paystack itself errors", async () => {
    verifyAs = () => ({ status: 503, body: { status: false, message: "down" } });
    const res = await deliver({ reference: "ref_503", metadata: planMeta });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(billing().status).toBe("pending");
  });

  it("answers 200 and changes nothing when Paystack does not know the reference", async () => {
    verifyAs = () => ({ status: 404, body: { status: false, message: "Transaction reference not found" } });
    const res = await deliver({ reference: "ref_unknown", metadata: planMeta });
    // Final, not transient: a redelivery would get the same answer.
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
  });

  it("answers 5xx when the verify call hangs past the timeout", async () => {
    // Paystack never answers; the fetch is released only by its signal.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise((_resolve, reject) => {
            // As real fetch does: an already-aborted signal rejects at once.
            if (init.signal?.aborted) reject(init.signal.reason);
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new DOMException("timed out", "TimeoutError")));
    try {
      const res = await deliver({ reference: "ref_hang", metadata: planMeta });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(billing().status).toBe("pending");
    } finally {
      timeout.mockRestore();
    }
  });

  it("does not activate on a partial payment of the requested amount", async () => {
    verifyAs = () =>
      verified({ reference: "ref_part", amount: 50000, requested_amount: 99900, metadata: planMeta });
    const res = await deliver({ reference: "ref_part", metadata: planMeta });
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
    expect(flags()).toHaveLength(1);
  });

  it("does not activate on a verified success for a different reference", async () => {
    verifyAs = () => verified({ reference: "ref_elsewhere", amount: 99900, metadata: planMeta });
    const res = await deliver({ reference: "ref_asked", metadata: planMeta });
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
  });

  it("flags a mismatched payment once per reference, however often it is redelivered", async () => {
    verifyAs = (call) =>
      verified({ reference: call.path.split("/").pop()!, amount: 100, metadata: planMeta });
    await deliver({ reference: "ref_low1", metadata: planMeta });
    await deliver({ reference: "ref_low1", metadata: planMeta });
    expect(flags()).toHaveLength(1);
    await deliver({ reference: "ref_low2", metadata: planMeta });
    expect(flags()).toHaveLength(2);
  });

  it("flags a second, separate payment for a plan already active (two tabs)", async () => {
    await deliver({ reference: "ref_tab1", metadata: planMeta });
    expect(billing().status).toBe("active");
    await deliver({ reference: "ref_tab2", metadata: planMeta });
    expect(flags()).toHaveLength(1);
    expect(flags()[0]).toMatchObject({ detail: expect.objectContaining({ reference: "ref_tab2" }) });
    // ...while a redelivery of the payment that activated it stays silent.
    await deliver({ reference: "ref_tab1", metadata: planMeta });
    expect(flags()).toHaveLength(1);
    expect(applyFeatureGates).toHaveBeenCalledTimes(1);
  });

  it("does not activate when Paystack says the transaction did not succeed", async () => {
    verifyAs = () =>
      verified({ reference: "ref_abandoned", amount: 99900, status: "abandoned", metadata: planMeta });
    const res = await deliver({ reference: "ref_abandoned", metadata: planMeta });
    expect(res.status).toBe(200);
    expect(billing().status).toBe("pending");
  });
});

describe("one-time charge", () => {
  it("does not mark a charge paid for less than it asked", async () => {
    verifyAs = () => verified({ reference: "ref_c1", amount: 100, metadata: chargeMeta });
    const res = await deliver({ reference: "ref_c1", metadata: chargeMeta });
    expect(res.status).toBe(200);
    expect(charge().status).toBe("pending");
    expect(flags()).toHaveLength(1);
  });

  it("does not mark a charge paid for MORE than it asked — charges match exactly", async () => {
    verifyAs = () => verified({ reference: "ref_over", amount: 600000, metadata: chargeMeta });
    const res = await deliver({ reference: "ref_over", metadata: chargeMeta });
    expect(res.status).toBe(200);
    expect(charge().status).toBe("pending");
    expect(flags()).toHaveLength(1);
  });

  it("does not mark paid a charge that belongs to another workspace", async () => {
    const meta = { ...chargeMeta, subAccountId: "sa_other" };
    verifyAs = () => verified({ reference: "ref_c2", amount: 500000, metadata: meta });
    const res = await deliver({ reference: "ref_c2", metadata: meta });
    expect(res.status).toBe(200);
    expect(charge().status).toBe("pending");
  });

  it("marks the charge paid on the exact amount, once", async () => {
    verifyAs = () => verified({ reference: "ref_c3", amount: 500000, metadata: chargeMeta });
    expect((await deliver({ reference: "ref_c3", metadata: chargeMeta })).status).toBe(200);
    expect(charge().status).toBe("paid");
    expect((await deliver({ reference: "ref_c3", metadata: chargeMeta })).status).toBe(200);
    expect(mem.list("billingEvents").filter((e) => e.event === "charge.paid")).toHaveLength(1);
  });
});

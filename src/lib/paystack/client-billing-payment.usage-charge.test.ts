import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The agency Paystack webhook settles a USAGE charge: the one-time
 * `billingCharges` doc the monthly close mints is paid by the same
 * `charge.success` path as a manual charge, so G2 needs no webhook change.
 * Real settle + lifecycle code and in-memory Firestore; only Paystack's
 * verify endpoint is replaced.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/server/billing-attention-notify", () => ({ notifyFlag: vi.fn(async () => {}) }));
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/paystack/billing-api", () => ({ verifyPaystackTransaction: verify }));

const { settleClientBillingPayment } = await import("./client-billing-payment");

const CHARGE = "usage_sa1_2026-09";
const tx = (over: Record<string, unknown> = {}) => ({
  status: "success",
  reference: "ref_1",
  amount: 5000,
  requested_amount: 5000,
  currency: "ZAR",
  id: 42,
  metadata: { kind: "subAccountCharge", chargeId: CHARGE, subAccountId: "sa1" },
  ...over,
});

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mem.seed(`billingCharges/${CHARGE}`, {
    id: CHARGE, agencyId: "ag1", subAccountId: "sa1", kind: "usage", usageMonth: "2026-09",
    description: "Usage — September 2026", amountCents: 5000, currency: "zar", status: "pending",
    tokenHash: "h", payUrl: "https://app.example.com/pay/charge/t", stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
  });
});

describe("settleClientBillingPayment on a usage charge", () => {
  it("marks it paid, once, and a redelivery changes nothing", async () => {
    verify.mockResolvedValue(tx());
    await settleClientBillingPayment("ref_1");
    await flushAfterResponse();
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({
      status: "paid",
      tokenHash: null,
      stripeCheckoutSessionId: "ref_1",
      stripePaymentIntentId: "42",
    });
    const paidAt = mem.read(`billingCharges/${CHARGE}`)?.paidAt;
    await settleClientBillingPayment("ref_1");
    await flushAfterResponse();
    expect(mem.read(`billingCharges/${CHARGE}`)?.paidAt).toEqual(paidAt);
    expect(mem.read(`billingCharges/${CHARGE}`)?.extraPaymentRefs).toBeUndefined();
  });

  it("does not settle a payment for less than the charge, and flags it", async () => {
    verify.mockResolvedValue(tx({ amount: 4000, requested_amount: 4000 }));
    await settleClientBillingPayment("ref_1");
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(mem.list("billingEvents").some((e) => e.event === "payment.flagged")).toBe(true);
  });

  it("does not settle a charge named by another sub-account's metadata", async () => {
    verify.mockResolvedValue(tx({ metadata: { kind: "subAccountCharge", chargeId: CHARGE, subAccountId: "sa2" } }));
    await settleClientBillingPayment("ref_1");
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
  });
});

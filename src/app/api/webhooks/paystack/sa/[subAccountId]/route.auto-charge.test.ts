import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AMOUNT,
  MANDATE,
  NOW,
  REF,
  SCHEDULE,
  chargeAnswer,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
} from "@/test/auto-charge-harness";
import { KEY, OTHER_KEY, SA, mem, refused, seedAttempt, seedInvoice, seedSub, stubPaystack } from "@/test/paystack-links-harness";
import { fireQuoteTrigger } from "@/lib/quotes/lifecycle";

/**
 * Seam test: a REAL card cycle (`runOneSchedule`) charges, then the REAL
 * webhook route records it. Only the verified webhook marks the invoice paid
 * — `paidVia.rail = "paystack_auto"` — and only the compare-and-set winner
 * fires `invoice.charge_succeeded`. A key or mode that is not the attempt's
 * flags the attempt and marks nothing paid.
 */

const fireWorkflowTrigger = vi.fn();

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0004" }));
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: vi.fn(async () => ({ id: "task1" })),
  territoryForContact: async () => null,
}));
vi.mock("@/lib/server/quote-send-service", () => ({ sendQuoteServerSide: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a),
}));
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));

const { POST } = await import("./route");
const { runOneSchedule } = await import("@/lib/server/recurring-invoice-service");
const { sweepAttempts } = await import("@/lib/paystack/attempt-sweep");
const { flagStaleAttempts } = await import("@/lib/server/payment-attempts");
const { markQuotePaidServerSide } = await import("@/lib/server/quotes-service");

function deliver(key = KEY, reference = REF) {
  const body = JSON.stringify({ event: "charge.success", data: { reference } });
  const signature = createHmac("sha512", key).update(body).digest("hex");
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${SA}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body,
    }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}

const attempt = () => mem.read(`paymentAttempts/${REF}`)!;
const succeeded = () => fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === "invoice.charge_succeeded");
const verifies = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/transaction/verify/"));

/** Run the card cycle so the attempt and invoice exist exactly as production writes them. */
async function chargedCycle(verify?: Record<string, unknown>) {
  const calls = stubAutoCharge({ verify });
  await runOneSchedule(SCHEDULE, NOW);
  expect(attempt()).toMatchObject({ state: "open" });
  return calls;
}

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedCardSchedule();
  seedMandate({ consecutiveDeclines: 1 });
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a card cycle's charge recorded by the verified webhook", () => {
  it("marks the invoice paid via paystack_auto, settles the attempt, fires charge_succeeded once", async () => {
    await chargedCycle();
    expect((await deliver()).status).toBe(200);

    const invoice = raised();
    expect(invoice).toMatchObject({
      status: "paid",
      paidVia: { rail: "paystack_auto", mandateId: MANDATE, reference: REF },
      autoCharge: { reference: REF, mandateId: MANDATE, state: "paid", reason: null },
    });
    expect(attempt()).toMatchObject({ state: "settled" });
    expect(mem.read(`paymentMandates/${MANDATE}`)).toMatchObject({ consecutiveDeclines: 0 });
    expect(succeeded()).toEqual([
      [{ agencyId: "ag1", subAccountId: SA, type: "invoice.charge_succeeded", contactId: "c1" }],
    ]);
    expect(fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("a replayed webhook writes nothing more and fires nothing more", async () => {
    await chargedCycle();
    await deliver();
    const after = raised();
    expect((await deliver()).status).toBe(200);
    expect(raised()).toEqual(after);
    expect(succeeded()).toHaveLength(1);
    expect(fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("an invoice already paid another way is not re-marked, fires nothing, and says a refund may be owed", async () => {
    await chargedCycle();
    const id = raised().id;
    mem.seed(`quotes/${id}`, { ...raised(), status: "paid", paidVia: { rail: "paystack_link", linkId: "l9", reference: "pl-l9-0123456789abcdef" } });
    expect((await deliver()).status).toBe(200);
    expect(raised()).toMatchObject({ paidVia: { rail: "paystack_link" }, autoCharge: { state: "needs_attention" } });
    expect(attempt().reason).toMatch(/refund may be owed/);
    expect(succeeded()).toHaveLength(0);
  });

  it("an invoice edited after the charge is not marked paid", async () => {
    await chargedCycle();
    mem.seed(`quotes/${raised().id}`, { ...raised(), globalTaxPercent: 0 });
    await deliver();
    expect(raised()).toMatchObject({ status: "draft", autoCharge: { state: "needs_attention" } });
    expect(succeeded()).toHaveLength(0);
  });
});

describe("what the webhook refuses to record", () => {
  it("a key other than the attempt's: flagged, never verified, not paid", async () => {
    const calls = await chargedCycle();
    seedSub(SA, OTHER_KEY);
    expect((await deliver(OTHER_KEY)).status).toBe(200);
    expect(attempt()).toMatchObject({ state: "flagged", reason: expect.stringMatching(/different key/) });
    expect(verifies(calls)).toHaveLength(0);
    expect(raised().status).toBe("draft");
    expect(succeeded()).toHaveLength(0);
  });

  it("a live-domain transaction on a test-mode attempt: flagged, not paid", async () => {
    await chargedCycle({ domain: "live" });
    await deliver();
    expect(attempt()).toMatchObject({ state: "flagged", reason: expect.stringMatching(/live-mode payment/) });
    expect(raised().status).toBe("draft");
    expect(succeeded()).toHaveLength(0);
  });

  it.each([
    ["a different requested amount", { amount: AMOUNT - 100 }],
    ["a partial amount", { amount: AMOUNT - 100, requested_amount: AMOUNT }],
    ["another currency", { currency: "NGN" }],
  ])("%s: flagged, not paid", async (_n, verify) => {
    await chargedCycle(verify);
    await deliver();
    expect(attempt()).toMatchObject({ state: "flagged" });
    expect(raised().status).toBe("draft");
  });

  it("not a success: nothing recorded", async () => {
    await chargedCycle({ status: "failed" });
    await deliver();
    expect(attempt()).toMatchObject({ state: "open" });
    expect(raised().status).toBe("draft");
  });

  it("another sub-account's attempt is ignored, even under the same key", async () => {
    const calls = stubAutoCharge();
    seedAttempt(REF, { subAccountId: "sa2", mandateId: MANDATE, invoiceId: "inv1", amountCents: AMOUNT });
    await deliver();
    expect(verifies(calls)).toHaveLength(0);
    expect(attempt()).toMatchObject({ state: "open" });
  });

  it("only the saved-card rail may settle a draft invoice", async () => {
    seedInvoice("inv1", { status: "draft" });
    const link = { rail: "paystack_link" as const, linkId: "l1", reference: "pl-l1-0123456789abcdef" };
    for (const paidVia of [undefined, link]) {
      const res = await markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: SA, paidVia });
      expect(res).toMatchObject({ ok: false, code: "bad_status" });
    }
  });

  it("a reference with no attempt is ignored", async () => {
    stubAutoCharge();
    expect((await deliver(KEY, `ra-${SCHEDULE}-c9`)).status).toBe(200);
    expect(mem.list("paymentAttempts")).toHaveLength(0);
  });

  it("Paystack unavailable → 503 so it redelivers; the redelivery records it", async () => {
    await chargedCycle();
    stubPaystack(() => refused(502, "Bad gateway"));
    expect((await deliver()).status).toBe(503);
    expect(raised().status).toBe("draft");
    stubAutoCharge();
    expect((await deliver()).status).toBe(200);
    expect(raised().status).toBe("paid");
  });

  it("a charge recorded as declined that later succeeds is not settled; the attempt and invoice say so", async () => {
    stubAutoCharge({ charge: () => chargeAnswer("failed", "Declined") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(raised().autoCharge).toMatchObject({ reference: REF, state: "declined" });
    await deliver();
    expect(attempt()).toMatchObject({ state: "refused", reason: expect.stringMatching(/later reported this charge/) });
    // The invoice no longer reads "declined", which offers a pay link.
    expect(raised().autoCharge).toMatchObject({
      reference: REF,
      state: "needs_attention",
      reason: expect.stringMatching(/later reported this charge/),
    });
    expect(raised().status).not.toBe("paid");
    expect(succeeded()).toHaveLength(0);
  });
});

describe("a connection change with an auto-charge open", () => {
  it("flagStaleAttempts flags it (it has no link)", async () => {
    await chargedCycle();
    await flagStaleAttempts(SA, null);
    expect(attempt()).toMatchObject({ state: "flagged", reason: expect.stringMatching(/disconnected/) });
  });

  it("the sweep records a success through the reconciler", async () => {
    await chargedCycle();
    await sweepAttempts(SA, KEY, [REF]);
    expect(raised()).toMatchObject({ status: "paid", paidVia: { rail: "paystack_auto" } });
    expect(succeeded()).toHaveLength(1);
  });

  it("the sweep closes a failed charge as refused — a saved-card charge cannot be resumed", async () => {
    await chargedCycle({ status: "failed" });
    await sweepAttempts(SA, KEY, [REF]);
    expect(attempt()).toMatchObject({ state: "refused" });
  });
});

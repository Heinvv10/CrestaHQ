import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import { KEY, SA, mem, seedAttempt, seedInvoice, seedLink, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * Ported from the round-4 breaker repro. A Paystack link is paid, the invoice
 * step fails transiently (503), and before Paystack redelivers the operator
 * clicks Mark as paid. The manual route must credit the paid link as the
 * payer, or the redelivery reads the invoice as "paid another way" and writes
 * a false "refund may be owed" on a single payment.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
const effects = vi.hoisted(() => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/quotes/lifecycle", () => effects);
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" ? { uid: "u1", subAccountId, subAccountRole: "admin" } : NextResponse.json({}, { status: 403 }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGateForContact: async () => null }));

const { POST: WEBHOOK } = await import("@/app/api/webhooks/paystack/sa/[subAccountId]/route");
const { POST: MARK_PAID } = await import("./route");

const REF = "pl-link1-0123456789abcdef";
function deliver() {
  const body = JSON.stringify({ event: "charge.success", data: { reference: REF } });
  const sig = createHmac("sha512", KEY).update(body).digest("hex");
  return WEBHOOK(
    new Request(`http://x/api/webhooks/paystack/sa/${SA}`, { method: "POST", headers: { "x-paystack-signature": sig }, body }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}
const markPaid = () =>
  MARK_PAID(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: SA, quoteId: "inv1" }) });

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedInvoice();
  seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
  seedAttempt(REF, { amountCents: 115000 });
  stubPaystack(() => verified({ reference: REF, amount: 115000 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("operator marks paid in the retry window: the redelivery raises no refund flag", async () => {
  const realDoc = mem.db.doc;
  let reads = 0;
  const spy = vi.spyOn(mem.db, "doc").mockImplementation((p: string) => {
    const r = realDoc(p);
    return p === "quotes/inv1" ? { ...r, get: () => (++reads === 1 ? Promise.reject(new Error("unavailable")) : r.get()) } : r;
  });
  expect((await deliver()).status).toBe(503);
  spy.mockRestore();
  expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid" });
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });

  expect((await markPaid()).status).toBe(200);
  expect(mem.read("quotes/inv1")!.paidVia).toEqual({ rail: "paystack_link", linkId: "link1", reference: REF });

  expect((await deliver()).status).toBe(200);
  expect(mem.read("paymentLinks/link1")!.invoiceAttention ?? null).toBeNull();
  expect(mem.read("paymentLinks/link1")!.invoiceSettledAt).toBeInstanceOf(Date);
  await flushAfterResponse();
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
});

it("a plain manual mark with no paid link records no paidVia", async () => {
  expect((await markPaid()).status).toBe(200);
  expect(mem.read("quotes/inv1")!.paidVia).toBeNull();
});

it("does not credit a link whose invoice step already settled", async () => {
  seedLink("link1", { invoiceId: "inv1", amountCents: 115000, status: "paid", paystackReference: REF, invoiceSettledAt: new Date() });
  expect((await markPaid()).status).toBe(200);
  expect(mem.read("quotes/inv1")!.paidVia).toBeNull();
});

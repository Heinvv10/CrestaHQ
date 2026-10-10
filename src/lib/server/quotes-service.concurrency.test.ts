import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * `markQuotePaidServerSide` is shared by the manual Mark as paid button, the
 * Stripe order reconciler and the Paystack payment-link reconciler. Any two can
 * race: two links for one invoice, a link racing the button, a redelivered
 * webhook. The status check and the paid write are one compare-and-set, so
 * exactly one caller wins and only the winner fires the side effects.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const effects = vi.hoisted(() => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/quotes/lifecycle", () => effects);
const review = vi.hoisted(() => vi.fn(async () => ({ sent: false })));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: review }));

const { markQuotePaidServerSide } = await import("./quotes-service");

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  mem.seed("quotes/inv1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", kind: "invoice", status: "sent" });
});

describe("overlapping mark-paid calls", () => {
  it("one wins, the other gets already_paid, and side effects fire once", async () => {
    const results = await Promise.all([
      markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1" }),
      markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1" }),
      markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "already_paid")).toHaveLength(2);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    await vi.waitFor(() => {
      expect(effects.recordQuoteActivity).toHaveBeenCalledTimes(1);
      expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
      expect(effects.emitQuoteWebhook).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledTimes(1);
    });
  });

  it("stores paidVia in the same write, and hands it back to a loser", async () => {
    const via = { rail: "paystack_link" as const, linkId: "l1", reference: "pl-l1-0123456789abcdef" };
    const [a, b] = await Promise.all([
      markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1", paidVia: via }),
      markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1" }),
    ]);
    const loser = [a, b].find((r) => !r.ok)!;
    expect(mem.read("quotes/inv1")!.paidVia).toEqual(a.ok ? via : null);
    expect(loser).toMatchObject({ code: "already_paid", paidVia: a.ok ? via : null });
  });

  it("records no paidVia for a caller that names no rail (the manual button)", async () => {
    await markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1" });
    expect(mem.read("quotes/inv1")!.paidVia).toBeNull();
  });
});

describe("expected total and currency, checked inside the compare-and-set", () => {
  const INV = {
    subAccountId: "sa1", agencyId: "ag1", contactId: "c1", kind: "invoice", status: "sent", currency: "ZAR",
    lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 1000 }], globalDiscount: null, globalTaxPercent: 15,
  };

  it("marks paid when the invoice still totals what the caller expects", async () => {
    mem.seed("quotes/inv1", INV);
    const res = await markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1", expectTotalCents: 115000, expectCurrency: "ZAR" });
    expect(res.ok).toBe(true);
  });

  it.each([
    ["total", { expectTotalCents: 100000, expectCurrency: "ZAR" }],
    ["currency", { expectTotalCents: 115000, expectCurrency: "USD" }],
  ])("refuses with amount_changed when the %s differs, and fires nothing", async (_l, expect_) => {
    mem.seed("quotes/inv1", INV);
    const res = await markQuotePaidServerSide({ quoteId: "inv1", expectSubAccountId: "sa1", ...expect_ });
    expect(res).toMatchObject({ ok: false, code: "amount_changed" });
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
  });
});

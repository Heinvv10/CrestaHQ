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
    expect(effects.recordQuoteActivity).toHaveBeenCalledTimes(1);
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
    expect(effects.emitQuoteWebhook).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The quote-paid → review-request seam (E2E 7's quote-paid half, which a
 * browser spec cannot drive without a real send). `markQuotePaidServerSide`
 * is the ONE paid path for both the operator's button and the Stripe
 * reconciler; it must hand the dispatcher `trigger: "quote_paid"` for the
 * quote's own tenant and contact — and nothing when the mark-paid is refused.
 * The dispatcher's own guards (config, trigger flags, opt-out, cooldown, the
 * WhatsApp rails) are proven in src/lib/reviews/*.test.ts.
 */

// In-memory Firestore: markQuotePaidServerSide checks and writes in one
// transaction, which the earlier hand-rolled fake had no support for.
const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: async () => {},
  fireQuoteTrigger: async () => {},
  emitQuoteWebhook: async () => {},
}));
const dispatcher = vi.hoisted(() => ({ send: vi.fn(async () => ({ sent: false, reason: "not_configured" })) }));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: dispatcher.send }));

const { markQuotePaidServerSide } = await import("./quotes-service");

const QUOTE = { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", kind: "quote", status: "accepted" };

beforeEach(() => {
  mem.clear();
  dispatcher.send.mockClear();
});

describe("quote paid → review request", () => {
  it("marking a quote paid asks for a review with trigger quote_paid", async () => {
    mem.seed("quotes/q1", { ...QUOTE });
    expect(await markQuotePaidServerSide({ quoteId: "q1", expectSubAccountId: "sa1" })).toMatchObject({ ok: true });
    await flushAfterResponse();
    expect(dispatcher.send).toHaveBeenCalledTimes(1);
    expect(dispatcher.send).toHaveBeenCalledWith({ subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "quote_paid" });
  });

  it("a refused mark-paid asks for nothing", async () => {
    mem.seed("quotes/paid", { ...QUOTE, status: "paid" });
    mem.seed("quotes/draft", { ...QUOTE, status: "draft" });
    mem.seed("quotes/other", { ...QUOTE, subAccountId: "sa_other" });
    for (const quoteId of ["paid", "draft", "other", "missing"]) {
      expect(await markQuotePaidServerSide({ quoteId, expectSubAccountId: "sa1" })).toMatchObject({ ok: false });
    }
    expect(dispatcher.send).not.toHaveBeenCalled();
  });
});

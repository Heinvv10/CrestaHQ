import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The quote-paid → review-request seam (E2E 7's quote-paid half, which a
 * browser spec cannot drive without a real send). `markQuotePaidServerSide`
 * is the ONE paid path for both the operator's button and the Stripe
 * reconciler; it must hand the dispatcher `trigger: "quote_paid"` for the
 * quote's own tenant and contact — and nothing when the mark-paid is refused.
 * The dispatcher's own guards (config, trigger flags, opt-out, cooldown, the
 * WhatsApp rails) are proven in src/lib/reviews/*.test.ts.
 */

const docs = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (c: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: docs.has(`${c}/${id}`), data: () => docs.get(`${c}/${id}`) }),
        update: async (patch: Record<string, unknown>) => void docs.set(`${c}/${id}`, { ...docs.get(`${c}/${id}`), ...patch }),
      }),
    }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "SERVER_TS" } }));
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: async () => {},
  fireQuoteTrigger: async () => {},
  emitQuoteWebhook: async () => {},
}));
const dispatcher = vi.hoisted(() => ({ send: vi.fn(async () => ({ sent: false, reason: "not_configured" })) }));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: dispatcher.send }));

import { markQuotePaidServerSide } from "./quotes-service";

const QUOTE = { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", kind: "quote", status: "accepted" };

beforeEach(() => {
  docs.clear();
  dispatcher.send.mockClear();
});

describe("quote paid → review request", () => {
  it("marking a quote paid asks for a review with trigger quote_paid", async () => {
    docs.set("quotes/q1", { ...QUOTE });
    expect(await markQuotePaidServerSide({ quoteId: "q1", expectSubAccountId: "sa1" })).toMatchObject({ ok: true });
    expect(dispatcher.send).toHaveBeenCalledTimes(1);
    expect(dispatcher.send).toHaveBeenCalledWith({ subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "quote_paid" });
  });

  it("a refused mark-paid asks for nothing", async () => {
    docs.set("quotes/paid", { ...QUOTE, status: "paid" });
    docs.set("quotes/draft", { ...QUOTE, status: "draft" });
    docs.set("quotes/other", { ...QUOTE, subAccountId: "sa_other" });
    for (const quoteId of ["paid", "draft", "other", "missing"]) {
      expect(await markQuotePaidServerSide({ quoteId, expectSubAccountId: "sa1" })).toMatchObject({ ok: false });
    }
    expect(dispatcher.send).not.toHaveBeenCalled();
  });
});

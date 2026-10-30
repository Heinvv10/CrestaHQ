import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, expect, it, vi } from "vitest";

/**
 * A signed quote's webhook payload: every event carries who signed, when and
 * the fingerprint; the signer's email and IP go out only on quote.accepted,
 * the event they were recorded for — not on every later view, send or paid.
 */

const dispatch = vi.hoisted(() => ({ emitWebhookEvent: vi.fn(async (_e: unknown) => undefined) }));
vi.mock("@/lib/api/webhooks/dispatch", () => dispatch);
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { emitQuoteWebhook } = await import("./lifecycle");

const SIGNED_AT = Timestamp.fromDate(new Date("2026-10-29T10:00:00Z"));
const QUOTE = {
  id: "q1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", kind: "quote", quoteNumber: "Q-1", status: "accepted", currency: "ZAR",
  lineItems: [{ id: "l1", description: "Install", quantity: 1, unitPrice: 100 }], globalDiscount: null, globalTaxPercent: null,
  signature: {
    signerName: "Jane Doe", signedAsNumber: "Q-1", signerEmail: "jane@example.com", signedAt: SIGNED_AT,
    ipAddress: "203.0.113.9", userAgent: "ua", documentHash: "a".repeat(64), hashVersion: 1,
  },
};
const payloadSignature = () =>
  ((dispatch.emitWebhookEvent.mock.calls[0][0] as { payload: { quote: { signature: unknown } } }).payload.quote.signature);

beforeEach(() => vi.clearAllMocks());

it("quote.accepted carries the signer's email and IP", async () => {
  await emitQuoteWebhook(QUOTE as never, "quote_accepted");
  expect(payloadSignature()).toEqual({
    signer_name: "Jane Doe",
    signed_at: "2026-10-29T10:00:00.000Z",
    document_hash: "a".repeat(64),
    signer_email: "jane@example.com",
    ip_address: "203.0.113.9",
  });
});

it.each(["quote_viewed", "quote_sent", "quote_declined", "quote_marked_paid"] as const)(
  "%s carries the signature without the email or IP",
  async (event) => {
    await emitQuoteWebhook(QUOTE as never, event);
    expect(payloadSignature()).toEqual({
      signer_name: "Jane Doe",
      signed_at: "2026-10-29T10:00:00.000Z",
      document_hash: "a".repeat(64),
    });
  },
);

it("an unsigned quote's payload has signature: null", async () => {
  await emitQuoteWebhook({ ...QUOTE, signature: null } as never, "quote_accepted");
  expect(payloadSignature()).toBeNull();
});

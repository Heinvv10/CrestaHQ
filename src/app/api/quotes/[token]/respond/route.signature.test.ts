import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The public accept route's typed-name signature, through the real route,
 * the real token check and the real transaction (in-memory Firestore):
 *   - a quote that requires a signature is never accepted without a valid
 *     name and the terms agreement, and a refused attempt writes nothing;
 *   - a signed accept writes the signature and the accept together, with
 *     the fingerprint of the content as read in the transaction;
 *   - a replay, a second signature (even after a re-send flipped the status
 *     back) and a concurrent double-submit are refused, leaving the first
 *     signature exactly as written;
 *   - a quote that doesn't require one keeps one-click accept.
 * The lifecycle follow-ups are spied: they have their own tests.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const lifecycle = vi.hoisted(() => ({
  recordQuoteActivity: vi.fn(async (..._a: unknown[]) => undefined),
  fireQuoteTrigger: vi.fn(async (..._a: unknown[]) => undefined),
  emitQuoteWebhook: vi.fn(async (..._a: unknown[]) => undefined),
  applyDealOutcomeForAcceptedQuote: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/quotes/lifecycle", () => lifecycle);

const SECRET = "test-secret-quote-signature-fixture";
process.env.AUTOMATIONS_TOKEN_SECRET = SECRET;

const { POST } = await import("./route");
const { issueQuoteToken } = await import("@/lib/quotes/token");
const { computeQuoteDocumentHash } = await import("@/lib/quotes/signature");

const QUOTE = {
  agencyId: "ag1",
  subAccountId: "sa1",
  createdByUid: "u1",
  contactId: "c1",
  kind: "quote",
  status: "viewed",
  quoteNumber: "Q-2026-0007",
  currency: "ZAR",
  lineItems: [{ id: "li1", description: "Fibre install", quantity: 1, unitPrice: 1500 }],
  globalDiscount: null,
  globalTaxPercent: 15,
  termsAndNotes: "50% deposit.",
  billedToOrganization: null,
  billingAddress: null,
  validUntil: null,
  autoCreateDealOnAccept: false,
  requireSignature: true,
  signature: null,
};

let token = "";

function seed(over: Record<string, unknown> = {}) {
  const issued = issueQuoteToken("q1");
  token = issued.token;
  mem.seed("quotes/q1", { ...QUOTE, publicTokenHash: issued.hash, ...over });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Jane", email: " jane@example.com " });
}

const respond = (body: unknown, headers: Record<string, string> = {}, t = token) =>
  POST(
    new Request("http://localhost/api/quotes/x/respond", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token: t }) },
  );

// What the signer's page computes from the content it rendered.
const SEEN = await computeQuoteDocumentHash(QUOTE as never);
const SIGN = { action: "accept", signerName: "  Jane   Doe ", agreedToTerms: true, documentHash: SEEN };
const NAME_ERR = "Type your full name to sign (2–120 characters).";
const STALE_PAGE = "This page is out of date — refresh it and sign again.";
const quote = () => mem.read("quotes/q1")!;

beforeAll(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = SECRET;
});

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
});

describe("a quote that requires a signature", () => {
  it.each([
    ["no name", { ...SIGN, signerName: undefined }, NAME_ERR],
    ["a one-letter name", { ...SIGN, signerName: "J" }, NAME_ERR],
    ["a 121-character name", { ...SIGN, signerName: "a".repeat(121) }, NAME_ERR],
    ["a name with a bidi override", { ...SIGN, signerName: "Jane \u202eeoD" }, NAME_ERR],
    ["a name that isn't a string", { ...SIGN, signerName: ["Jane Doe"] }, NAME_ERR],
    ["no terms agreement", { ...SIGN, agreedToTerms: undefined }, "Tick the box to confirm you agree to the terms."],
    ["agreement that isn't exactly true", { ...SIGN, agreedToTerms: "true" }, "Tick the box to confirm you agree to the terms."],
    ["no document fingerprint", { ...SIGN, documentHash: undefined }, STALE_PAGE],
    ["an upper-case fingerprint", { ...SIGN, documentHash: SEEN.toUpperCase() }, STALE_PAGE],
    ["a short fingerprint", { ...SIGN, documentHash: SEEN.slice(1) }, STALE_PAGE],
    ["a fingerprint that isn't a string", { ...SIGN, documentHash: [SEEN] }, STALE_PAGE],
  ])("%s -> 400, nothing written, no follow-ups", async (_label, body, error) => {
    seed();
    const before = quote();
    const res = await respond(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(quote()).toEqual(before);
    await flushAfterResponse();
    expect(lifecycle.recordQuoteActivity).not.toHaveBeenCalled();
    expect(lifecycle.fireQuoteTrigger).not.toHaveBeenCalled();
    expect(lifecycle.emitQuoteWebhook).not.toHaveBeenCalled();
    expect(lifecycle.applyDealOutcomeForAcceptedQuote).not.toHaveBeenCalled();
  });

  it("a valid signature accepts and records who, when, from where and what", async () => {
    seed();
    const expectedHash = await computeQuoteDocumentHash(quote() as never);
    const res = await respond(SIGN, {
      // The caller controls the left of X-Forwarded-For; the proxy appends the right.
      "x-forwarded-for": "6.6.6.6, 203.0.113.9",
      "user-agent": "Mozilla/5.0 test",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted", signed: true });

    const q = quote();
    expect(q.status).toBe("accepted");
    expect(q.acceptedAt).toBeInstanceOf(Date);
    expect(q.signature).toEqual({
      signerName: "Jane Doe",
      signedAsNumber: "Q-2026-0007",
      signerEmail: "jane@example.com",
      // Resolved by Firestore on commit; the in-memory store keeps a nested sentinel as is.
      signedAt: FieldValue.serverTimestamp(),
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 test",
      documentHash: expectedHash,
      hashVersion: 1,
    });
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);

    expect(lifecycle.recordQuoteActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q1" }),
      "quote_accepted",
      { extra: "signed by Jane Doe" },
    );
    expect(lifecycle.fireQuoteTrigger).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }), "quote_accepted");
    expect(lifecycle.applyDealOutcomeForAcceptedQuote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a line's price", { lineItems: [{ ...QUOTE.lineItems[0], unitPrice: 1400 }] }],
    ["the terms", { termsAndNotes: "Full payment up front." }],
    ["the validity", { validUntil: Timestamp.fromMillis(Date.now() + 30 * 86_400_000) }],
  ])("%s edited after the signer's page loaded -> 409, nothing written, no follow-ups", async (_label, edit) => {
    seed(edit);
    const before = quote();
    const res = await respond(SIGN);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This quote changed — refresh to see the latest version." });
    expect(quote()).toEqual(before);
    await flushAfterResponse();
    expect(lifecycle.recordQuoteActivity).not.toHaveBeenCalled();
    expect(lifecycle.applyDealOutcomeForAcceptedQuote).not.toHaveBeenCalled();
  });

  it("the fingerprint the page sends is the one stored", async () => {
    seed();
    expect((await respond(SIGN)).status).toBe(200);
    expect((quote().signature as { documentHash: string }).documentHash).toBe(SEEN);
  });

  it("caps the stored user agent at 500 characters", async () => {
    seed();
    expect((await respond(SIGN, { "user-agent": "x".repeat(2000) })).status).toBe(200);
    expect((quote().signature as { userAgent: string }).userAgent).toHaveLength(500);
  });

  it("a replay of the same signed accept -> 409, the first signature untouched", async () => {
    seed();
    expect((await respond(SIGN)).status).toBe(200);
    const first = quote();
    vi.clearAllMocks();

    const res = await respond({ ...SIGN, signerName: "Mallory Other" });
    expect(res.status).toBe(409);
    expect(quote()).toEqual(first);
    expect(lifecycle.recordQuoteActivity).not.toHaveBeenCalled();
  });

  it("a second signature on a quote a re-send flipped back to sent -> 409, untouched", async () => {
    const existing = {
      signerName: "Jane Doe",
      signedAsNumber: "Q-2026-0007",
      signerEmail: "jane@example.com",
      signedAt: new Date("2026-10-01T10:00:00Z"),
      ipAddress: "203.0.113.9",
      userAgent: "ua",
      documentHash: "a".repeat(64),
      hashVersion: 1,
    };
    seed({ status: "sent", signature: existing });
    const before = quote();
    for (const body of [{ ...SIGN, signerName: "Mallory Other" }, { action: "decline", reason: "Bad timing" }]) {
      const res = await respond(body);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("This quote has already been signed — refresh the page to see the latest.");
    }
    expect(quote()).toEqual(before);
  });

  it("two signed accepts at once: exactly one signs, the other is refused", async () => {
    seed();
    const results = await Promise.all([
      respond({ ...SIGN, signerName: "Jane Doe" }),
      respond({ ...SIGN, signerName: "Jane Q Doe" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = (await Promise.all(results.map((r) => r.json()))).findIndex((b) => b.ok === true);
    expect((quote().signature as { signerName: string }).signerName).toBe(["Jane Doe", "Jane Q Doe"][winner]);
    expect(lifecycle.recordQuoteActivity).toHaveBeenCalledTimes(1);
  });

  it("a contact in another sub-account never lends the signature its email", async () => {
    seed();
    mem.seed("contacts/c1", { subAccountId: "sa2", agencyId: "ag1", email: "someone-else@example.com" });
    expect((await respond(SIGN)).status).toBe(200);
    expect((quote().signature as { signerEmail: string | null }).signerEmail).toBeNull();
  });

  it("an expired quote is refused before any signature is written", async () => {
    seed({ validUntil: Timestamp.fromMillis(Date.now() - 86_400_000) });
    const before = quote();
    expect((await respond(SIGN)).status).toBe(409);
    expect(quote()).toEqual(before);
  });

  it("a forged token -> 404, nothing written", async () => {
    seed();
    const before = quote();
    const forged = `${token.slice(0, -4)}0000`;
    expect((await respond(SIGN, {}, forged)).status).toBe(404);
    expect(quote()).toEqual(before);
  });

  it("decline still works without a name", async () => {
    seed();
    const res = await respond({ action: "decline", reason: "Bad timing" });
    expect(res.status).toBe(200);
    expect(quote()).toMatchObject({ status: "declined", signature: null });
  });
});

describe("a quote that doesn't require a signature", () => {
  it.each([
    ["requireSignature false", { requireSignature: false }],
    ["an older doc without the field", { requireSignature: undefined }],
    ["an invoice with the flag set", { kind: "invoice", requireSignature: true }],
  ])("%s: one-click accept, no signature", async (_label, over) => {
    seed(over);
    const res = await respond({ action: "accept" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted" });
    expect(quote().status).toBe("accepted");
    expect(quote().signature ?? null).toBeNull();
    expect(lifecycle.recordQuoteActivity).toHaveBeenCalledWith(expect.anything(), "quote_accepted", { extra: null });
  });

  it("a name sent anyway is not recorded as a signature", async () => {
    seed({ requireSignature: false });
    expect((await respond(SIGN)).status).toBe(200);
    expect(quote().signature ?? null).toBeNull();
  });
});

import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  computeQuoteDocumentHash,
  normalizeSignerName,
  quoteDocumentBody,
  quoteRequiresSignature,
} from "./signature";

/**
 * The signed-quote fingerprint and the signer-name check the public accept
 * route relies on. The hash must follow exactly what was agreed (items,
 * money, terms, parties, validity) and nothing else: converting a signed
 * quote to an invoice renumbers it and changes its kind and status, and the
 * fingerprint must still verify.
 */

const VALID_UNTIL = new Date("2026-12-31T21:59:59.000Z");

const QUOTE = {
  quoteNumber: "Q-2026-0007",
  kind: "quote" as const,
  status: "viewed" as const,
  paymentDueDays: null,
  currency: "ZAR",
  lineItems: [
    { id: "li1", description: "Fibre install", quantity: 1, unitPrice: 1500, productId: "p1" },
    { id: "li2", description: "Router", quantity: 2, unitPrice: 899 },
  ],
  globalDiscount: { type: "percent" as const, value: 10 },
  globalTaxPercent: 15,
  termsAndNotes: "50% deposit on acceptance.",
  billedToOrganization: "Acme Holdings Pty Ltd",
  billingAddress: "1 Main Rd, Pretoria",
  validUntil: Timestamp.fromDate(VALID_UNTIL),
};

const hash = (q: Parameters<typeof computeQuoteDocumentHash>[0]) => computeQuoteDocumentHash(q);

describe("computeQuoteDocumentHash", () => {
  it("is the SHA-256 of the canonical body", async () => {
    const expected = createHash("sha256").update(quoteDocumentBody(QUOTE)).digest("hex");
    expect(await hash(QUOTE)).toBe(expected);
    expect(await hash(QUOTE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("survives renumbering to an invoice (number, kind, status, due days)", async () => {
    const converted = {
      ...QUOTE,
      quoteNumber: "INV-2026-0031",
      kind: "invoice" as const,
      status: "draft" as const,
      paymentDueDays: 7,
      publicTokenHash: "",
      sentAt: null,
      convertedFromQuoteAt: Timestamp.now(),
    };
    expect(await hash(converted)).toBe(await hash(QUOTE));
  });

  it("ignores line-item ids, product links and key order", async () => {
    const reordered = {
      ...QUOTE,
      lineItems: QUOTE.lineItems.map((li, i) => ({ unitPrice: li.unitPrice, quantity: li.quantity, description: li.description, id: `other${i}` })),
      globalDiscount: { value: 10, type: "percent" as const },
    };
    expect(await hash(reordered)).toBe(await hash(QUOTE));
  });

  it("hashes validUntil the same as a Timestamp, Date, epoch ms or ISO string", async () => {
    const base = await hash(QUOTE);
    for (const validUntil of [VALID_UNTIL, VALID_UNTIL.getTime(), VALID_UNTIL.toISOString(), { seconds: VALID_UNTIL.getTime() / 1000 }]) {
      expect(await hash({ ...QUOTE, validUntil: validUntil as never })).toBe(base);
    }
  });

  it.each([
    ["a line's price", { lineItems: [{ ...QUOTE.lineItems[0], unitPrice: 1400 }, QUOTE.lineItems[1]] }],
    ["a line's quantity", { lineItems: [QUOTE.lineItems[0], { ...QUOTE.lineItems[1], quantity: 3 }] }],
    ["a line's description", { lineItems: [{ ...QUOTE.lineItems[0], description: "Fibre install (premium)" }, QUOTE.lineItems[1]] }],
    ["a dropped line", { lineItems: [QUOTE.lineItems[0]] }],
    ["the line order", { lineItems: [QUOTE.lineItems[1], QUOTE.lineItems[0]] }],
    ["the currency", { currency: "USD" }],
    ["the discount", { globalDiscount: { type: "flat" as const, value: 10 } }],
    ["the tax", { globalTaxPercent: 0 }],
    ["the terms", { termsAndNotes: "Full payment on acceptance." }],
    ["the billed-to organisation", { billedToOrganization: "Someone Else Ltd" }],
    ["the billing address", { billingAddress: "2 Main Rd, Pretoria" }],
    ["the validity", { validUntil: Timestamp.fromDate(new Date("2027-01-31T21:59:59.000Z")) }],
    ["no validity", { validUntil: null }],
  ])("changes when %s changes", async (_label, patch) => {
    expect(await hash({ ...QUOTE, ...patch })).not.toBe(await hash(QUOTE));
  });
});

describe("quoteRequiresSignature", () => {
  it("only a quote with requireSignature exactly true", () => {
    expect(quoteRequiresSignature({ kind: "quote", requireSignature: true })).toBe(true);
    // Older docs have no kind: they are quotes.
    expect(quoteRequiresSignature({ kind: undefined as never, requireSignature: true })).toBe(true);
    // Absent on older docs: outstanding links keep one-click accept.
    expect(quoteRequiresSignature({ kind: "quote", requireSignature: undefined })).toBe(false);
    expect(quoteRequiresSignature({ kind: "quote", requireSignature: false })).toBe(false);
    expect(quoteRequiresSignature({ kind: "quote", requireSignature: "true" as never })).toBe(false);
    // Invoices are paid, not signed.
    expect(quoteRequiresSignature({ kind: "invoice", requireSignature: true })).toBe(false);
  });
});

describe("normalizeSignerName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeSignerName("  Jane \n\t  van  der Merwe ")).toBe("Jane van der Merwe");
  });

  it("accepts 2 and 120 characters, refuses 1 and 121", () => {
    expect(normalizeSignerName("Jo")).toBe("Jo");
    expect(normalizeSignerName("J")).toBeNull();
    expect(normalizeSignerName("a".repeat(120))).toBe("a".repeat(120));
    expect(normalizeSignerName("a".repeat(121))).toBeNull();
    // Measured after collapsing: padding can't sneak a short name past the minimum.
    expect(normalizeSignerName("   J   ")).toBeNull();
  });

  it.each([
    ["a non-string", 42],
    ["null", null],
    ["an object", { toString: () => "Jane Doe" }],
    ["a right-to-left override", "Jane ‮eoD"],
    ["a NUL", "Jane\u0000Doe"],
    ["a zero-width space", "Jane​Doe"],
    ["a bell", "Jane\u0007Doe"],
  ])("refuses %s", (_label, raw) => {
    expect(normalizeSignerName(raw)).toBeNull();
  });

  it("keeps names in other scripts, including a joiner inside a word", () => {
    expect(normalizeSignerName("Thandiwe Nkosi-Mbeki")).toBe("Thandiwe Nkosi-Mbeki");
    expect(normalizeSignerName("José Ñúñez")).toBe("José Ñúñez");
    expect(normalizeSignerName("می‌روز")).toBe("می‌روز");
  });
});

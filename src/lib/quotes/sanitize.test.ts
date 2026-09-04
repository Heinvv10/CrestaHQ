import { describe, expect, it } from "vitest";

import { sanitizeQuoteTemplate } from "./sanitize";

/**
 * The clamps that stand between an operator's form and a stored document.
 *
 * Extracted from the quote-create route so a recurring schedule stores the
 * same template a hand-made invoice does; these pin the behaviour that route
 * had before the extraction.
 */

describe("sanitizeQuoteTemplate", () => {
  it("omits fields the body never mentioned", () => {
    // A PATCH spreads this over a stored document, so a key appearing here
    // with an empty value would blank a field nobody touched.
    expect(sanitizeQuoteTemplate({})).toEqual({});
  });

  it("floors negative quantities and prices at zero", () => {
    const { lineItems } = sanitizeQuoteTemplate({
      lineItems: [{ id: "a", description: " Work ", quantity: -3, unitPrice: -1 }],
    });
    expect(lineItems).toEqual([
      { id: "a", description: "Work", quantity: 0, unitPrice: 0, productId: null },
    ]);
  });

  it("drops line items that are not objects", () => {
    const { lineItems } = sanitizeQuoteTemplate({ lineItems: ["nope", null, 7] });
    expect(lineItems).toEqual([]);
  });

  it("gives an unnamed line item an id rather than storing undefined", () => {
    const { lineItems } = sanitizeQuoteTemplate({
      lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }],
    });
    expect(lineItems?.[0]?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("upper-cases and truncates the currency to three characters", () => {
    expect(sanitizeQuoteTemplate({ currency: " zarand " }).currency).toBe("ZAR");
  });

  it("keeps an explicit null discount but ignores an unknown discount type", () => {
    expect(sanitizeQuoteTemplate({ globalDiscount: null }).globalDiscount).toBeNull();
    expect(
      sanitizeQuoteTemplate({ globalDiscount: { type: "half-off", value: 5 } }),
    ).toEqual({});
  });

  it("ignores a tax percentage outside 0-100", () => {
    expect(sanitizeQuoteTemplate({ globalTaxPercent: 101 })).toEqual({});
    expect(sanitizeQuoteTemplate({ globalTaxPercent: 15 }).globalTaxPercent).toBe(15);
  });

  it("rounds payment due days and ignores an out-of-range value", () => {
    expect(sanitizeQuoteTemplate({ paymentDueDays: 7.4 }).paymentDueDays).toBe(7);
    expect(sanitizeQuoteTemplate({ paymentDueDays: 400 })).toEqual({});
    expect(sanitizeQuoteTemplate({ paymentDueDays: 0 }).paymentDueDays).toBe(0);
  });

  it("turns an all-whitespace organization or address into null", () => {
    const out = sanitizeQuoteTemplate({ billedToOrganization: "  ", billingAddress: "  " });
    expect(out.billedToOrganization).toBeNull();
    expect(out.billingAddress).toBeNull();
  });

  it("caps the terms block", () => {
    const out = sanitizeQuoteTemplate({ termsAndNotes: "x".repeat(20_000) });
    expect(out.termsAndNotes).toHaveLength(10_000);
  });
});

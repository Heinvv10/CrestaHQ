/**
 * Cleaning and clamping for the money/document fields an operator submits on
 * a quote, an invoice, or a recurring-invoice template.
 *
 * These fields are identical across all three — a recurring schedule stores
 * the same template a hand-made invoice stores — so the rules for what a
 * quantity, a discount or a terms block may contain live here once rather
 * than being retyped per route. Structure is trusted (the client is typed);
 * values are not.
 */

import type { QuoteDiscount, QuoteLineItem } from "@/types/quotes";

/** The subset every quote-shaped document shares. */
export interface QuoteTemplateFields {
  lineItems: QuoteLineItem[];
  currency: string;
  globalDiscount: QuoteDiscount;
  globalTaxPercent: number | null;
  termsAndNotes: string;
  billedToOrganization: string | null;
  billingAddress: string | null;
  paymentDueDays: number | null;
}

export interface QuoteTemplateInput {
  lineItems?: unknown;
  currency?: unknown;
  globalDiscount?: unknown;
  globalTaxPercent?: unknown;
  termsAndNotes?: unknown;
  billedToOrganization?: unknown;
  billingAddress?: unknown;
  paymentDueDays?: unknown;
}

/**
 * Pick out the template fields that were actually supplied.
 *
 * Absent keys are absent from the result, so the same function serves a
 * create (spread over defaults) and a PATCH (spread over the stored doc)
 * without a partial update silently blanking a field nobody touched.
 */
export function sanitizeQuoteTemplate(
  body: QuoteTemplateInput,
): Partial<QuoteTemplateFields> {
  const out: Partial<QuoteTemplateFields> = {};

  if (Array.isArray(body.lineItems)) {
    out.lineItems = body.lineItems
      .map(sanitizeLineItem)
      .filter((x): x is QuoteLineItem => x !== null);
  }

  if (typeof body.currency === "string" && body.currency.trim()) {
    out.currency = body.currency.trim().toUpperCase().slice(0, 3);
  }

  if (body.globalDiscount === null) {
    out.globalDiscount = null;
  } else if (
    body.globalDiscount &&
    typeof body.globalDiscount === "object" &&
    isDiscountType((body.globalDiscount as QuoteDiscount)?.type)
  ) {
    const discount = body.globalDiscount as { type: "percent" | "flat"; value: unknown };
    out.globalDiscount = {
      type: discount.type,
      value: Math.max(0, Number(discount.value) || 0),
    };
  }

  if (body.globalTaxPercent === null) {
    out.globalTaxPercent = null;
  } else if (typeof body.globalTaxPercent === "number") {
    const v = body.globalTaxPercent;
    if (!Number.isNaN(v) && v >= 0 && v <= 100) out.globalTaxPercent = v;
  }

  if (typeof body.termsAndNotes === "string") {
    // Cap to prevent runaway-size docs. ~10k chars is plenty.
    out.termsAndNotes = body.termsAndNotes.trim().slice(0, 10_000);
  }

  if (body.billedToOrganization === null) {
    out.billedToOrganization = null;
  } else if (typeof body.billedToOrganization === "string") {
    const trimmed = body.billedToOrganization.trim();
    out.billedToOrganization = trimmed ? trimmed.slice(0, 200) : null;
  }

  if (body.billingAddress === null) {
    out.billingAddress = null;
  } else if (typeof body.billingAddress === "string") {
    // Allow newlines for multi-line addresses; cap to keep doc size sane.
    const trimmed = body.billingAddress.trim();
    out.billingAddress = trimmed ? trimmed.slice(0, 1_000) : null;
  }

  if (body.paymentDueDays === null) {
    out.paymentDueDays = null;
  } else if (
    typeof body.paymentDueDays === "number" &&
    Number.isFinite(body.paymentDueDays) &&
    body.paymentDueDays >= 0 &&
    body.paymentDueDays <= 365
  ) {
    out.paymentDueDays = Math.round(body.paymentDueDays);
  }

  return out;
}

function isDiscountType(type: unknown): type is "percent" | "flat" {
  return type === "percent" || type === "flat";
}

function sanitizeLineItem(item: unknown): QuoteLineItem | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<QuoteLineItem>;
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  const quantity = Math.max(0, Number(raw.quantity) || 0);
  const unitPrice = Math.max(0, Number(raw.unitPrice) || 0);
  const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();
  const productId =
    typeof raw.productId === "string" && raw.productId ? raw.productId : null;
  return { id, description, quantity, unitPrice, productId };
}

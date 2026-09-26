import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { CapabilityUserError, type ValidateResult } from "./types";
import { ISO_DATE_RE } from "./helpers";
import { hasUnsafeText, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/**
 * The quote fields an agent may set (create_quote / update_quote), checked
 * before the quotes route's own sanitizer (lib/server/quote-write.ts) runs.
 */

export const QUOTE_FIELD_PROPS = {
  lineItems: {
    type: "array",
    description: "The whole list of lines (replaces the current one).",
    items: {
      type: "object",
      properties: {
        description: { type: "string" },
        quantity: { type: "number" },
        unitPrice: { type: "number", description: "In whole units of the currency, e.g. 499.99." },
        productId: { type: "string", description: "The catalog product (from list_products), if any." },
      },
      required: ["description", "quantity", "unitPrice"],
      additionalProperties: false,
    },
  },
  currency: { type: "string", description: "3-letter code." },
  globalDiscount: {
    type: ["object", "null"],
    properties: { type: { type: "string", enum: ["percent", "flat"] }, value: { type: "number" } },
    required: ["type", "value"],
    additionalProperties: false,
  },
  globalTaxPercent: { type: ["number", "null"], description: "0 to 100." },
  termsAndNotes: { type: "string" },
  billedToOrganization: { type: ["string", "null"] },
  billingAddress: { type: ["string", "null"] },
  validUntilDateString: { type: ["string", "null"], description: "Quotes: yyyy-mm-dd." },
  paymentDueDays: { type: ["number", "null"], description: "Invoices: 0 to 365." },
  autoCreateDealOnAccept: { type: "boolean" },
  dealId: { type: ["string", "null"], description: "Quotes: a deal of the same contact (from find_deals)." },
};

export const QUOTE_FIELD_KEYS = Object.keys(QUOTE_FIELD_PROPS);
const MULTILINE = new Set(["termsAndNotes", "billingAddress"]);
const TEXT = ["termsAndNotes", "billedToOrganization", "billingAddress"];

const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** The asked fields, checked; line ids are numbered when not given, so the
 *  same call always makes the same proposal. */
export function quoteFields(raw: unknown): ValidateResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of QUOTE_FIELD_KEYS) if (r[k] !== undefined) out[k] = r[k];
  for (const k of TEXT) {
    const v = out[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, error: `${k} must be text` };
    if (hasUnsafeText(MULTILINE.has(k) ? v.replace(/\r?\n/g, " ") : v)) return { ok: false, error: `${k} ${UNSAFE_TEXT_MESSAGE}` };
  }
  if (out.lineItems !== undefined) {
    if (!Array.isArray(out.lineItems) || !out.lineItems.length || out.lineItems.length > 200) return { ok: false, error: "lineItems must list 1 to 200 lines" };
    const lines: Record<string, unknown>[] = [];
    for (const [i, li] of (out.lineItems as unknown[]).entries()) {
      const l = (li ?? {}) as Record<string, unknown>;
      if (typeof l.description !== "string" || !l.description.trim() || hasUnsafeText(l.description)) return { ok: false, error: `line ${i + 1} needs a description of visible text` };
      if (!num(l.quantity, 0, 1e6) || !num(l.unitPrice, 0, 1e9)) return { ok: false, error: `line ${i + 1}: quantity and unitPrice must be numbers, 0 or more` };
      if (l.productId !== undefined && !isDocId(l.productId)) return { ok: false, error: `line ${i + 1}: productId must be a product's id` };
      lines.push({ id: `line${i + 1}`, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, ...(l.productId ? { productId: l.productId } : {}) });
    }
    out.lineItems = lines;
  }
  if (out.currency !== undefined && (typeof out.currency !== "string" || !/^[A-Za-z]{3}$/.test(out.currency))) return { ok: false, error: "currency must be a 3-letter code" };
  const d = out.globalDiscount as { type?: unknown; value?: unknown } | null | undefined;
  if (d !== undefined && d !== null && (!["percent", "flat"].includes(d.type as string) || !num(d.value, 0, d.type === "percent" ? 100 : 1e9))) {
    return { ok: false, error: "globalDiscount must be a percent (0 to 100) or a flat amount, 0 or more" };
  }
  if (out.globalTaxPercent !== undefined && out.globalTaxPercent !== null && !num(out.globalTaxPercent, 0, 100)) return { ok: false, error: "globalTaxPercent must be 0 to 100" };
  if (out.paymentDueDays !== undefined && out.paymentDueDays !== null && !num(out.paymentDueDays, 0, 365)) return { ok: false, error: "paymentDueDays must be 0 to 365" };
  if (out.validUntilDateString !== undefined && out.validUntilDateString !== null && !(typeof out.validUntilDateString === "string" && ISO_DATE_RE.test(out.validUntilDateString))) {
    return { ok: false, error: "validUntilDateString must be yyyy-mm-dd" };
  }
  if (out.autoCreateDealOnAccept !== undefined && typeof out.autoCreateDealOnAccept !== "boolean") return { ok: false, error: "autoCreateDealOnAccept must be true or false" };
  if (out.dealId !== undefined && out.dealId !== null && !isDocId(out.dealId)) return { ok: false, error: "dealId must be a deal's id" };
  return { ok: true, args: out };
}

/** Every catalog product a line names must be this sub-account's. */
export async function assertTenantProducts(subAccountId: string, lines: unknown): Promise<void> {
  const ids = [...new Set((Array.isArray(lines) ? lines : []).map((l) => (l as { productId?: string }).productId).filter(isDocId))];
  const snaps = await Promise.all(ids.map((id) => getAdminDb().doc(`products/${id}`).get()));
  if (snaps.some((s) => s.data()?.subAccountId !== subAccountId)) throw new CapabilityUserError("A line names a product that isn't in this workspace.");
}

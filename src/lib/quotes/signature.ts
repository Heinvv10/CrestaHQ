import { hasUnsafeText } from "@/lib/ai-suite/capabilities/text-safety";
import {
  SIGNER_NAME_MAX,
  SIGNER_NAME_MIN,
  type Quote,
} from "@/types/quotes";

/**
 * Document fingerprint for a signed quote. Pure and dependency-free so the
 * public page, the accept route and the PDF all compute the same value.
 *
 * Covers exactly what the recipient agreed to (items, money, terms, parties,
 * validity). Lifecycle fields are left out on purpose: a later status change
 * or re-send must not change the fingerprint of what was signed.
 */

export const QUOTE_HASH_VERSION = 1 as const;

type HashInput = Pick<
  Quote,
  | "currency"
  | "lineItems"
  | "globalDiscount"
  | "globalTaxPercent"
  | "termsAndNotes"
  | "billedToOrganization"
  | "billingAddress"
  | "validUntil"
>;

/** Stable JSON: object keys sorted at every level, arrays kept in order. */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Representation-independent: Timestamp, Date, epoch ms or ISO string all hash the same. */
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().toISOString();
  if (typeof maybe.seconds === "number") {
    return new Date(maybe.seconds * 1000).toISOString();
  }
  return null;
}

/**
 * The exact string that gets hashed. Exported so a verifier can rebuild it.
 * The document number is deliberately not included: converting a signed quote
 * to an invoice renumbers it, and the fingerprint must still verify.
 */
export function quoteDocumentBody(quote: HashInput): string {
  return canonicalize({
    v: QUOTE_HASH_VERSION,
    currency: quote.currency,
    lineItems: quote.lineItems.map((li) => ({
      description: li.description,
      quantity: Number(li.quantity) || 0,
      unitPrice: Number(li.unitPrice) || 0,
    })),
    globalDiscount: quote.globalDiscount ?? null,
    globalTaxPercent: quote.globalTaxPercent ?? null,
    termsAndNotes: quote.termsAndNotes ?? "",
    billedToOrganization: quote.billedToOrganization ?? null,
    billingAddress: quote.billingAddress ?? null,
    validUntil: isoOrNull(quote.validUntil),
  });
}

/** SHA-256 hex of the canonical body. Node and browser share WebCrypto. */
export async function computeQuoteDocumentHash(
  quote: HashInput,
): Promise<string> {
  const bytes = new TextEncoder().encode(quoteDocumentBody(quote));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Signature is only ever required on quotes; invoices are paid, not signed. */
export function quoteRequiresSignature(
  quote: Pick<Quote, "kind" | "requireSignature">,
): boolean {
  return (quote.kind ?? "quote") === "quote" && quote.requireSignature === true;
}

/**
 * The typed name, whitespace collapsed, or null when it can't be a signature:
 * outside the length bounds, or carrying a control, invisible or bidi
 * character (the name is printed on the signed record, where a right-to-left
 * override could make it read as someone else's).
 */
export function normalizeSignerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < SIGNER_NAME_MIN || name.length > SIGNER_NAME_MAX) {
    return null;
  }
  if (hasUnsafeText(name)) return null;
  return name;
}

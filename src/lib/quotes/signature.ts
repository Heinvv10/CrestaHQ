import { hasUnsafeText } from "@/lib/ai-suite/capabilities/text-safety";
import {
  SIGNER_NAME_MAX,
  SIGNER_NAME_MIN,
  type Quote,
} from "@/types/quotes";

/**
 * Document fingerprint for a signed quote. Pure and isomorphic so the public
 * page (from what it rendered) and the accept route (from the doc in its
 * transaction) compute the same value.
 *
 * Covers what the recipient agreed to: line items, money, terms, the
 * billed-to organisation and address, and validity. Not the contact the quote
 * points at (a contact merge legitimately re-points `contactId`), and not
 * lifecycle fields: a later status change or re-send must not change the
 * fingerprint of what was signed.
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
> & {
  /** Any representation: the server holds a Timestamp, the public page epoch ms. */
  validUntil: unknown;
};

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

/** Whole epoch milliseconds, floored, from any representation. */
function epochMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") return new Date(v).getTime();
  const maybe = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
  if (typeof maybe.toMillis === "function") return maybe.toMillis();
  if (typeof maybe.seconds === "number") {
    // Floored before adding: seconds * 1000 + 999.999999 rounds up to the next ms in a double.
    return maybe.seconds * 1000 + Math.floor((maybe.nanoseconds ?? 0) / 1e6);
  }
  return null;
}

/**
 * Representation-independent: Timestamp, Date, epoch ms or ISO string all hash
 * the same. A Timestamp carries nanoseconds and the public page receives its
 * `toMillis()`, possibly fractional, so both sides floor to whole ms first.
 */
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const ms = epochMs(v);
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms)).toISOString();
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
 * outside the length bounds, fewer than two letters (digits, punctuation or
 * combining marks alone are not a name), or carrying a control, invisible or
 * bidi character (a right-to-left override could make the recorded name read
 * as someone else's).
 */
export function normalizeSignerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < SIGNER_NAME_MIN || name.length > SIGNER_NAME_MAX) {
    return null;
  }
  if ((name.match(/\p{L}/gu) ?? []).length < 2) return null;
  if (hasUnsafeText(name)) return null;
  return name;
}

import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

/**
 * Phone normalization for contact WRITE paths.
 *
 * Contacts historically stored phone numbers exactly as typed, which broke
 * three things at once:
 *  - Dedupe matched the exact string, so "(305) 555-1234" and "+13055551234"
 *    became two contacts (and voice, which reconciles phone-first, split a
 *    booking and a call from the same customer in two).
 *  - Every parse site calls `parsePhoneNumberFromString` with no default
 *    country, so a nationally-formatted number failed `isValid()` and the
 *    outbound-voice compliance gate refused to dial it.
 *  - Junk like "78893" was accepted as a phone number.
 *
 * The workspace's `defaultPhoneCountry` (SubAccountDoc, defaults US) is a
 * FALLBACK for bare national numbers, never a restriction: input with a
 * leading "+" always parses as its own country, so international leads work
 * regardless of the workspace default.
 *
 * Strictness varies by entry point:
 *  - Public forms use `normalizePhoneE164` and reject `null` (interactive —
 *    the visitor can fix it; a direct POST gets the same 400).
 *  - CSV import / manual entry / booking use `normalizePhoneLenient` — store
 *    E.164 when possible, keep the raw string otherwise, so a bulk import
 *    never loses a row to one bad cell.
 *
 * Pure + client-safe (no server imports) so forms can reuse it for inline
 * validation.
 */

export const DEFAULT_PHONE_COUNTRY: CountryCode = "US";

/** Coerce a stored workspace value ("us", " AU ", junk, null) to a CountryCode. */
export function coercePhoneCountry(country?: string | null): CountryCode {
  const c = country?.trim().toUpperCase();
  return c && /^[A-Z]{2}$/.test(c)
    ? (c as CountryCode)
    : DEFAULT_PHONE_COUNTRY;
}

/** E.164 (`+13055551234`) when the input parses to a valid number, else null. */
export function normalizePhoneE164(
  raw: string | null | undefined,
  country?: string | null,
): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parsed = parsePhoneNumberFromString(s, coercePhoneCountry(country));
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * E.164 when possible, otherwise the trimmed original. Empty input → "".
 * For write paths that must never drop a record over a bad phone.
 */
export function normalizePhoneLenient(
  raw: string | null | undefined,
  country?: string | null,
): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return normalizePhoneE164(s, country) ?? s;
}

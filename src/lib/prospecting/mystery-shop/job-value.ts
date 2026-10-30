import type { ContactProspecting } from "@/types";
import { JOB_VALUE_DEFAULT_CENTS, MYSTERY_SHOP_CURRENCY } from "./model";

/**
 * What a missed mystery-shop lead is worth: the sub-account's
 * `prospectingJobValues[niche]` in cents, else JOB_VALUE_DEFAULT_CENTS. The
 * niche key is the prospect's category, normalised. Sub-accounts have no
 * currency of their own, so it is always ZAR.
 */

export const JOB_VALUE_MAX_CENTS = 100_000_000;
export const NICHE_KEY_MAX_LEN = 60;
export const JOB_VALUES_MAX_ENTRIES = 50;

/** "Hair Care", "hair_care", " hair-care " → "hair_care". Empty → "". */
export function nicheKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, NICHE_KEY_MAX_LEN);
}

export function jobValueFor(
  prospecting: ContactProspecting | null | undefined,
  values: Record<string, number> | null | undefined,
): { niche: string; jobValueCents: number; currency: string } {
  const niche = nicheKey(prospecting?.category);
  const v = niche ? values?.[niche] : undefined;
  const ok = Number.isInteger(v) && (v as number) >= 0 && (v as number) <= JOB_VALUE_MAX_CENTS;
  return { niche, jobValueCents: ok ? (v as number) : JOB_VALUE_DEFAULT_CENTS, currency: MYSTERY_SHOP_CURRENCY };
}

/**
 * The settings PUT's `jobValues`: at most 50 niches, each key normalised
 * (non-empty, ≤ 60 chars) and each value whole cents 0–100,000,000. Null =
 * refuse the request.
 */
export function parseJobValues(input: unknown): Record<string, number> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input);
  if (entries.length > JOB_VALUES_MAX_ENTRIES) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (k.length > NICHE_KEY_MAX_LEN) return null;
    const key = nicheKey(k);
    if (!key || key in out) return null;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > JOB_VALUE_MAX_CENTS) return null;
    out[key] = v as number;
  }
  return out;
}

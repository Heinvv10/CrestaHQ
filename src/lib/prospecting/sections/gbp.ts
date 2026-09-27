import "server-only";

import type { ProspectFinding } from "@/types";
import { measured, unavailable, type Scored, type SectionInput } from "./types";

/**
 * Section 2 — Google Business Profile completeness, from one Places Details
 * (New) call per report. The field mask decides the SKU: hours and phone are
 * Enterprise fields (the tier Get Leads' Text Search already bills at);
 * `editorialSummary` is Enterprise + Atmosphere, so the description is not
 * requested and is reported as not measured. Places cannot tell whether a
 * profile is claimed, so `gbp_unclaimed` is never emitted here.
 *
 * `addressComponents` (an Essentials field, so no higher SKU) is not scored:
 * it gives the ApexGEO scan the business's town and country (`placeLocation`),
 * which the runner prefers over the contact's — prospect imports rarely carry
 * a city, and a form contact's city is an IP guess.
 */

export const key = "gbp" as const;

const DETAILS_URL = "https://places.googleapis.com/v1/places/";
/** Places ids are URL-safe tokens; anything else never reaches the request path. */
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;

export const GBP_FIELD_MASK = "id,businessStatus,photos,regularOpeningHours,nationalPhoneNumber,addressComponents";

/**
 * Town and ISO country code from the Places Details `addressComponents` a
 * gbp section kept, or nulls. Town = `locality`, else `postal_town`; never a
 * suburb or a municipality, which would make odd local-search prompts.
 */
export function placeLocation(sections: { key: string; raw: Record<string, unknown> }[]): {
  city: string | null;
  countryCode: string | null;
} {
  const details = sections.find((s) => s.key === key)?.raw.details as { addressComponents?: unknown } | undefined;
  const components = Array.isArray(details?.addressComponents) ? details.addressComponents : [];
  const text = (type: string, field: "longText" | "shortText") => {
    for (const c of components as { types?: unknown; longText?: unknown; shortText?: unknown }[]) {
      const value = c?.[field];
      if (Array.isArray(c?.types) && c.types.includes(type) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  };
  const country = text("country", "shortText");
  return {
    city: text("locality", "longText") ?? text("postal_town", "longText"),
    countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
  };
}

export function score(details: Record<string, unknown>): Scored {
  const hours = details.regularOpeningHours as { weekdayDescriptions?: unknown[] } | undefined;
  const checks: [boolean, ProspectFinding][] = [
    [
      Array.isArray(hours?.weekdayDescriptions) && hours.weekdayDescriptions.length > 0,
      { code: "gbp_no_hours", text: "The Google Business Profile shows no opening hours." },
    ],
    [
      Array.isArray(details.photos) && details.photos.length > 0,
      { code: "gbp_no_photos", text: "The Google Business Profile has no photos." },
    ],
    [
      typeof details.nationalPhoneNumber === "string" && details.nationalPhoneNumber.trim() !== "",
      { code: "gbp_no_phone", text: "The Google Business Profile has no phone number." },
    ],
  ];
  const passed = checks.filter(([ok]) => ok).length;
  return {
    score: Math.round((passed / checks.length) * 100),
    findings: checks.filter(([ok]) => !ok).map(([, finding]) => finding),
  };
}

export async function run(input: SectionInput) {
  const placeId = input.business.placeId;
  if (!placeId) return unavailable(key, "No Google place id on this contact.");
  if (!PLACE_ID.test(placeId)) return unavailable(key, "The stored Google place id is malformed.");
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) return unavailable(key, "GOOGLE_PLACES_API_KEY is not configured.");

  input.count("placesDetails");
  const res = await fetch(`${DETAILS_URL}${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": GBP_FIELD_MASK },
    signal: input.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Places details returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const details = (await res.json()) as Record<string, unknown>;
  return measured(key, score(details), {
    details,
    description: "notMeasured",
    claimed: "notMeasured",
  });
}

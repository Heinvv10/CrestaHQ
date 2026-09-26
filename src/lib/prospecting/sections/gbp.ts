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
 */

export const key = "gbp" as const;

const DETAILS_URL = "https://places.googleapis.com/v1/places/";
export const GBP_FIELD_MASK = "id,businessStatus,photos,regularOpeningHours,nationalPhoneNumber";

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

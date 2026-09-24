import "server-only";

import type { GetLeadsBusiness } from "@/types/get-leads";

/**
 * Google Places API (New) Text Search — the Get Leads data source. One
 * agency-level key per deployment (GOOGLE_PLACES_API_KEY, restricted to
 * places.googleapis.com + the Geocoding API, which geocode.ts uses) shared
 * by every sub-account.
 *
 * Cost control lives in two places: the field mask below (it decides the
 * billing SKU — adding review, photo or atmosphere fields moves every call
 * to a pricier tier) and the page cap (each page is a billable call, so a
 * search makes at most ceil(limit / 20) calls). Emails + socials are not a
 * Places field; `enrich.ts` reads them off each business's homepage.
 */

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const PAGE_SIZE = 20;
const MAX_BIAS_RADIUS_M = 50_000;
const CALL_TIMEOUT_MS = 10_000;

export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.primaryTypeDisplayName",
  "nextPageToken",
].join(",");

export function placesIsConfigured(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY?.trim();
}

export class PlacesError extends Error {
  status: number;
  /** Google answered RESOURCE_EXHAUSTED — the project's daily cap is spent. */
  quotaExhausted: boolean;
  constructor(message: string, status: number, quotaExhausted = false) {
    super(message);
    this.name = "PlacesError";
    this.status = status;
    this.quotaExhausted = quotaExhausted;
  }
}

export async function searchPlaces(params: {
  textQuery: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  limit: number;
}): Promise<GetLeadsBusiness[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    throw new PlacesError("GOOGLE_PLACES_API_KEY is not configured", 503);
  }

  const baseBody = {
    textQuery: params.textQuery,
    pageSize: Math.min(params.limit, PAGE_SIZE),
    locationBias: {
      circle: {
        center: { latitude: params.latitude, longitude: params.longitude },
        radius: Math.min(params.radiusKm * 1000, MAX_BIAS_RADIUS_M),
      },
    },
  };

  const maxCalls = Math.ceil(params.limit / PAGE_SIZE);
  const rows: Record<string, unknown>[] = [];
  let pageToken: string | null = null;
  for (let call = 0; call < maxCalls; call++) {
    const page = await searchTextPage(apiKey, pageToken ? { ...baseBody, pageToken } : baseBody);
    rows.push(...page.rows);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  return rows.slice(0, params.limit).map(normalizePlace);
}

async function searchTextPage(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[]; nextPageToken: string | null }> {
  const res = await fetch(SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": PLACES_FIELD_MASK,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const exhausted = res.status === 429 || text.includes("RESOURCE_EXHAUSTED");
    throw new PlacesError(
      `Places searchText returned ${res.status}: ${text.slice(0, 200)}`,
      exhausted ? 429 : 502,
      exhausted,
    );
  }

  const json = (await res.json().catch(() => ({}))) as {
    places?: unknown;
    nextPageToken?: unknown;
  };
  const rows = Array.isArray(json.places)
    ? json.places.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : [];
  return { rows, nextPageToken: str(json.nextPageToken) };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function locality(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  for (const c of components) {
    const types = obj(c).types;
    if (Array.isArray(types) && types.includes("locality")) return str(obj(c).longText);
  }
  return null;
}

/**
 * Map one Places (New) row to our wire format. Defensive throughout — every
 * field in the mask is optional on Google's side.
 */
function normalizePlace(raw: Record<string, unknown>): GetLeadsBusiness {
  const name = str(obj(raw.displayName).text) ?? "Unknown business";
  const location = obj(raw.location);
  const latitude = num(location.latitude);
  const longitude = num(location.longitude);
  const googlePlaceId = str(raw.id);
  return {
    placeId: googlePlaceId ?? `${name}:${latitude ?? ""},${longitude ?? ""}`,
    googlePlaceId,
    name,
    category: str(obj(raw.primaryTypeDisplayName).text),
    fullAddress: str(raw.formattedAddress),
    city: locality(raw.addressComponents),
    phone: str(raw.internationalPhoneNumber) ?? str(raw.nationalPhoneNumber),
    website: str(raw.websiteUri),
    email: null,
    facebook: null,
    instagram: null,
    rating: num(raw.rating),
    reviewsCount: num(raw.userRatingCount),
    latitude,
    longitude,
  };
}

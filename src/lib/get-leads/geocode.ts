import "server-only";

/**
 * Google Geocoding API — turns a typed place name ("Gqeberha") into search
 * coordinates when the page has no Mapbox token to resolve it client-side.
 * Uses the same GOOGLE_PLACES_API_KEY; the key's Google Cloud project must
 * also have the Geocoding API enabled (and should carry a daily cap — every
 * call here is one lookup against it).
 */

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const CALL_TIMEOUT_MS = 10_000;

export type GeocodeFailure = "not_found" | "quota" | "upstream" | "not_configured";

export class GeocodeError extends Error {
  status: number;
  reason: GeocodeFailure;
  constructor(message: string, status: number, reason: GeocodeFailure) {
    super(message);
    this.name = "GeocodeError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GeocodedPlace {
  lat: number;
  lng: number;
  formattedName: string;
}

export async function geocodePlace(name: string): Promise<GeocodedPlace> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    throw new GeocodeError("GOOGLE_PLACES_API_KEY is not configured", 503, "not_configured");
  }

  const url = `${GEOCODE_URL}?address=${encodeURIComponent(name)}&key=${encodeURIComponent(apiKey)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (err) {
    throw new GeocodeError(
      `Geocoding request failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
      "upstream",
    );
  }

  if (res.status === 429) {
    throw new GeocodeError("Geocoding returned 429", 429, "quota");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GeocodeError(`Geocoding returned ${res.status}: ${text.slice(0, 200)}`, 502, "upstream");
  }

  const json = (await res.json().catch(() => null)) as {
    status?: unknown;
    error_message?: unknown;
    results?: unknown;
  } | null;
  const status = typeof json?.status === "string" ? json.status : "INVALID_RESPONSE";

  if (status === "ZERO_RESULTS") {
    throw new GeocodeError(`No geocoding result for "${name}"`, 400, "not_found");
  }
  if (status === "OVER_QUERY_LIMIT" || status === "OVER_DAILY_LIMIT") {
    throw new GeocodeError(`Geocoding quota exhausted (${status})`, 429, "quota");
  }
  if (status !== "OK") {
    const detail = typeof json?.error_message === "string" ? `: ${json.error_message.slice(0, 200)}` : "";
    throw new GeocodeError(`Geocoding returned ${status}${detail}`, 502, "upstream");
  }

  const first = Array.isArray(json?.results) ? (json.results[0] as Record<string, unknown> | undefined) : undefined;
  const location = (first?.geometry as { location?: { lat?: unknown; lng?: unknown } } | undefined)?.location;
  const lat = location?.lat;
  const lng = location?.lng;
  if (typeof lat !== "number" || !Number.isFinite(lat) || typeof lng !== "number" || !Number.isFinite(lng)) {
    throw new GeocodeError("Geocoding returned OK without usable coordinates", 502, "upstream");
  }
  const formatted = first?.formatted_address;
  return {
    lat,
    lng,
    formattedName: typeof formatted === "string" && formatted.trim() ? formatted.trim() : name,
  };
}

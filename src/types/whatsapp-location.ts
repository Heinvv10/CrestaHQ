/**
 * A location a customer shared on WhatsApp (📎 → Location), on either inbound
 * rail (Cloud API, Go bridge).
 *
 * The coordinates are customer personal data — usually their home (POPIA).
 * Nothing that handles this shape may put them in a log line.
 */
export interface WhatsappLocation {
  latitude: number;
  longitude: number;
  /** Customer-supplied. Text only — never an href, never HTML. */
  name?: string;
  /** Customer-supplied. Text only — never an href, never HTML. */
  address?: string;
  /** Customer-supplied. Stored as sent and NEVER used as a link: see
   *  `googleMapsUrl`, which is built from the numbers alone. */
  url?: string;
}

/** Per string field, in code points. A place name or street address is far
 *  shorter; the cap keeps a hostile one off the row and out of the preview. */
export const MAX_LOCATION_TEXT = 256;

// C0 and C1 control characters, DEL included.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

// Zero-width characters, bidi marks/embeddings/overrides/isolates, and the BOM.
// Removed outright: they render as nothing, so a name made only of them is
// no name, and a bidi override can make shown text read differently.
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function cleanText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = Array.from(
    v.replace(CONTROL_CHARS, " ").replace(INVISIBLE_CHARS, "").trim(),
  )
    .slice(0, MAX_LOCATION_TEXT)
    .join("")
    .trim();
  return cleaned || undefined;
}

function coordinate(v: unknown, bound: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= -bound && v <= bound
    ? v
    : null;
}

/**
 * Narrow an untrusted value — a webhook body or a stored row — to a location,
 * or null.
 *
 * Coordinates must be real numbers in range: a string, NaN, Infinity or an
 * out-of-range value is not a location, and the whole thing is refused rather
 * than half-kept. Optional strings are cleaned and capped; one that is not a
 * string, or is empty once cleaned, is omitted (never written as `undefined`,
 * which Firestore refuses).
 */
export function parseWhatsappLocation(value: unknown): WhatsappLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const latitude = coordinate(v.latitude, 90);
  const longitude = coordinate(v.longitude, 180);
  if (latitude === null || longitude === null) return null;
  const out: WhatsappLocation = { latitude, longitude };
  const name = cleanText(v.name);
  const address = cleanText(v.address);
  const url = cleanText(v.url);
  if (name) out.name = name;
  if (address) out.address = address;
  if (url) out.url = url;
  return out;
}

/** Row body and conversation preview for a shared location. */
export function locationPreviewLabel(loc: WhatsappLocation): string {
  return loc.name ? `📍 ${loc.name}` : "📍 Location";
}

/** Six decimals is about 0.1 m (sub-metre) — exactly that north–south, and
 *  finer east–west away from the equator. `toFixed` never emits exponent
 *  notation. */
export function formatCoordinates(loc: WhatsappLocation): string {
  return `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`;
}

/**
 * The "Open in Google Maps" link. Built from the two NUMBERS only — never from
 * the customer-supplied `url`, `name` or `address`, so untrusted input can
 * never become an href (a `javascript:` url would otherwise run in the
 * operator's session).
 */
export function googleMapsUrl(loc: WhatsappLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${loc.latitude.toFixed(6)},${loc.longitude.toFixed(6)}`;
}

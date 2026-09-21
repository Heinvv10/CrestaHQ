import {
  WA_PROFILE_LIMITS,
  WA_VERTICALS,
  type WaBusinessProfile,
  type WaBusinessProfileInput,
  type WaMessageLink,
  type WaPhoneStatus,
  type WaQualityRating,
} from "./types";

/**
 * Pure mapping + validation for the Graph settings provider. No I/O, no
 * `server-only`: the route tests and the client form share the limits.
 * Fixtures for the parsers are the recorded Meta responses in
 * docs/parity/sp15.md.
 */

type Json = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** Never throws: Meta adds values over time ("NA" has been seen in the wild). */
export function mapQualityRating(raw: unknown): WaQualityRating {
  switch (typeof raw === "string" ? raw.toUpperCase() : "") {
    case "GREEN":
      return "GREEN";
    case "YELLOW":
      return "YELLOW";
    case "RED":
      return "RED";
    default:
      return "UNKNOWN";
  }
}

/** `GET /{phoneNumberId}?fields=…` */
export function parsePhoneStatus(json: unknown): WaPhoneStatus {
  const j = (json ?? {}) as Json;
  return {
    displayPhoneNumber: str(j.display_phone_number),
    verifiedName: str(j.verified_name),
    qualityRating: mapQualityRating(j.quality_rating),
    nameStatus: str(j.name_status),
    status: str(j.status),
  };
}

/**
 * `GET /{phoneNumberId}/whatsapp_business_profile` — takes the whole response
 * (`{data:[…]}`) or one entry. Unset fields are ABSENT in Meta's reply, not
 * null, so every string defaults to "" for the form.
 */
export function parseProfile(json: unknown): WaBusinessProfile {
  const outer = (json ?? {}) as Json;
  const entry = (Array.isArray(outer.data) ? (outer.data[0] ?? {}) : outer) as Json;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    about: s(entry.about),
    address: s(entry.address),
    description: s(entry.description),
    email: s(entry.email),
    websites: Array.isArray(entry.websites)
      ? entry.websites.filter((w): w is string => typeof w === "string")
      : [],
    vertical: s(entry.vertical) || "UNDEFINED",
    profilePictureUrl: str(entry.profile_picture_url),
  };
}

/** One `message_qrdls` entry. */
export function parseMessageLink(json: unknown): WaMessageLink {
  const j = (json ?? {}) as Json;
  return {
    code: str(j.code) ?? "",
    prefilledMessage: typeof j.prefilled_message === "string" ? j.prefilled_message : "",
    deepLinkUrl: str(j.deep_link_url) ?? "",
    qrImageUrl: str(j.qr_image_url),
  };
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The profile form → what the provider sends. Meta's own limits, enforced
 * here so a too-long field is a 400 with a field name rather than an opaque
 * Graph error. Strings are trimmed; an empty string clears the field.
 */
export function validateProfileInput(raw: unknown): Validated<WaBusinessProfileInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Profile must be an object." };
  }
  const r = raw as Json;
  const text = (key: "about" | "address" | "description" | "email"): string | { error: string } => {
    const v = r[key] ?? "";
    if (typeof v !== "string") return { error: `${key} must be text.` };
    const t = v.trim();
    if (t.length > WA_PROFILE_LIMITS[key]) {
      return { error: `${key} must be ${WA_PROFILE_LIMITS[key]} characters or fewer.` };
    }
    return t;
  };
  const fields = {} as Record<"about" | "address" | "description" | "email", string>;
  for (const key of ["about", "address", "description", "email"] as const) {
    const v = text(key);
    if (typeof v !== "string") return { ok: false, error: v.error };
    fields[key] = v;
  }
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return { ok: false, error: "email must be a valid address." };
  }

  const rawSites = r.websites ?? [];
  if (!Array.isArray(rawSites) || rawSites.some((w) => typeof w !== "string")) {
    return { ok: false, error: "websites must be a list of URLs." };
  }
  const websites = (rawSites as string[]).map((w) => w.trim()).filter((w) => w.length > 0);
  if (websites.length > WA_PROFILE_LIMITS.websites) {
    return { ok: false, error: `At most ${WA_PROFILE_LIMITS.websites} websites.` };
  }
  for (const w of websites) {
    if (w.length > WA_PROFILE_LIMITS.website) {
      return { ok: false, error: `Each website must be ${WA_PROFILE_LIMITS.website} characters or fewer.` };
    }
    if (!isHttpUrl(w)) return { ok: false, error: `Website "${w}" must start with http:// or https://.` };
  }

  const vertical = typeof r.vertical === "string" && r.vertical ? r.vertical : "UNDEFINED";
  if (!(WA_VERTICALS as readonly string[]).includes(vertical)) {
    return { ok: false, error: "vertical is not one of Meta's business categories." };
  }

  return { ok: true, value: { ...fields, websites, vertical } };
}

/** Message-link text: non-empty, ≤140 chars (Meta caps the URL it builds). */
export function validatePrefilledMessage(raw: unknown): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: "prefilledMessage must be text." };
  const t = raw.trim();
  if (!t) return { ok: false, error: "prefilledMessage is required." };
  if (t.length > WA_PROFILE_LIMITS.prefilledMessage) {
    return { ok: false, error: `prefilledMessage must be ${WA_PROFILE_LIMITS.prefilledMessage} characters or fewer.` };
  }
  return { ok: true, value: t };
}

import type { CaseDetail, ContactDetail } from "./qcontact.ts";

export const IMPORT_TAG = "qcontact-install";
export const IMPORT_SOURCE = "qcontact";

/** Body for POST /api/v1/contacts/upsert. */
export type UpsertBody = {
  phone: string;
  name: string;
  address?: string;
  source: string;
  tags_add: string[];
  custom_fields: Record<string, string>;
};

export type Mapped =
  | { ok: true; body: UpsertBody }
  | { ok: false; reason: "no_phone" | "no_name" };

function str(v: unknown): string | undefined {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

// South Africa's bounding box. Anything outside this is not a real
// Velocity install location — could be a QContact default/zero value, a
// swapped lat/lng, or garbage — so it's dropped rather than sent.
const SA_LAT_MIN = -35;
const SA_LAT_MAX = -22;
const SA_LNG_MIN = 16;
const SA_LNG_MAX = 33;

/**
 * `c__location_pin` on a case is an id, not coordinates — it resolves to a
 * separate `c__contactlocation` entity (see qcontact.ts#getLocation) whose
 * `c__latitude`/`c__longitude` are the customer's real coordinates. Only
 * returns "<lat>,<lng>" when both parse as finite numbers inside South
 * Africa's bounding box; the caller (run.ts) counts anything else as
 * skipped-invalid.
 */
export function gpsFromLocationFields(fields: Record<string, unknown>): string | undefined {
  const lat = num(fields.c__latitude);
  const lng = num(fields.c__longitude);
  if (lat === undefined || lng === undefined) return undefined;
  if (lat < SA_LAT_MIN || lat > SA_LAT_MAX || lng < SA_LNG_MIN || lng > SA_LNG_MAX) return undefined;
  return `${lat},${lng}`;
}

/** The case's `c__location_pin`, trimmed — the id to resolve via getLocation. */
export function locationPinId(c: CaseDetail): string | undefined {
  return str(c.fields.c__location_pin);
}

/** QContact stores phones as "e164:27821234567" (no plus). */
export function phoneFromQContact(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const digits = s.replace(/^e164:/, "").replace(/\D/g, "");
  return digits.length >= 9 ? `+${digits}` : undefined;
}

/**
 * Case + its linked Contact → upsert body. The phone comes from the Contact
 * (the case's own c__contact_number is empty on most rows); the case's
 * value is the fallback. Only keys with a value are sent: the upsert merges
 * custom fields per key and refuses unknown keys, so every key here must
 * exist on the sub-account (see README).
 *
 * `gps`, when given, is the "<lat>,<lng>" already resolved from the case's
 * location pin (see gpsFromLocationFields) — resolving it requires an HTTP
 * call, so run.ts does that once per pin and passes the result in here.
 */
export function mapCase(c: CaseDetail, contact: ContactDetail | null, gps?: string): Mapped {
  const cf = contact?.fields ?? {};
  const phone = phoneFromQContact(cf.telephone) ?? phoneFromQContact(c.fields.c__contact_number);
  if (!phone) return { ok: false, reason: "no_phone" };

  const name =
    [str(cf.first_name), str(cf.last_name)].filter(Boolean).join(" ") ||
    str(c.fields.c__contact_name) ||
    str(contact?.label);
  if (!name) return { ok: false, reason: "no_name" };

  const custom: Record<string, string> = { qcontact_case_id: String(c.id) };
  const ref = str(c.fields.reference);
  if (ref) custom.qcontact_case_ref = ref;
  const pin = locationPinId(c);
  if (pin) custom.qcontact_location_pin = pin;
  if (gps) custom.qcontact_location_gps = gps;
  const dr = str(cf.c__drop_number);
  if (dr) custom.velocity_dr_number = dr;

  const address = str(cf.addressline_1);
  return {
    ok: true,
    body: {
      phone,
      name,
      ...(address ? { address } : {}),
      source: IMPORT_SOURCE,
      tags_add: [IMPORT_TAG],
      custom_fields: custom,
    },
  };
}

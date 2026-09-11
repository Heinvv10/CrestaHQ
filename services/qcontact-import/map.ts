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
 */
export function mapCase(c: CaseDetail, contact: ContactDetail | null): Mapped {
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
  const pin = str(c.fields.c__location_pin);
  if (pin) custom.qcontact_location_pin = pin;
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

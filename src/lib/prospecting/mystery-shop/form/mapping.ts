/**
 * Which value goes in which field of a website contact form — heuristic,
 * from what the page says about each field (name, id, placeholder, label,
 * aria-label, autocomplete, type). Pure: page-scan.ts reads the fields in the
 * browser, this decides, engine.ts types.
 *
 * Only VISIBLE fields are ever filled: hidden inputs and honeypots (`trap`:
 * covered, clipped, tabindex -1 or named like one) stay empty, and a REQUIRED
 * trap refuses the form (`honeypot_required`).
 * A required field this cannot fill truthfully refuses the whole form
 * (`unmapped_required`, naming the fields) — nothing is invented. A required
 * consent checkbox refuses too (`consent_checkbox`): ticking it would accept
 * the business's terms on the operator's behalf. Optional checkboxes and
 * radios are never touched; a service `<select>` is set only when one of its
 * options names the service, else left at its default.
 */

export interface FormField {
  /** The `data-lsms` marker page-scan.ts put on the element. */
  key: string;
  tag: "input" | "textarea" | "select";
  type: string;
  /** name, id, placeholder, label, aria-label and autocomplete, lower-cased and joined. */
  hint: string;
  /** `hint` without the placeholder, which holds example VALUES ("e.g. Cape Town Plumbers"): what the field IS. */
  named: string;
  required: boolean;
  visible: boolean;
  /** Visible-looking but no person could type in it (page-scan.ts): a honeypot. */
  trap?: boolean;
  options?: { value: string; text: string }[];
  /** The select's current value. */
  value?: string;
}

export interface FormIdentity {
  /** The sub-account's business name. */
  business: string;
  /** The synced mailbox address, so the reply is matched. */
  email: string;
  /** The sub-account's number in E.164, if it has one. */
  phone: string | null;
  subject: string;
  message: string;
  /** The prospect's service, as the enquiry names it ("plumber"). */
  service: string;
  /** The town the enquiry names (the contact's city), if it names one. */
  town: string | null;
}

export type FieldRole = "name" | "first" | "last" | "email" | "phone" | "company" | "subject" | "message" | "service" | "town";

export interface Fill {
  key: string;
  role: FieldRole;
  value: string;
  kind: "fill" | "select";
}

export type FieldPlan =
  | { ok: true; fills: Fill[]; roles: FieldRole[] }
  | { ok: false; code: "unmapped_required" | "consent_checkbox" | "file_upload" | "honeypot_required"; reason: string };

const TEXTLIKE = new Set(["", "text", "email", "tel", "url", "number", "search"]);
const CONSENT = /privacy|terms|consent|agree|accept|gdpr|popia|policy|t&c|conditions/;
/**
 * Town / suburb / city (`address-level2` is the HTML autocomplete token); whole words, `_` and `-` count as
 * breaks (billing_city). Never a field that also says address (bar that token), street, postal code, zip,
 * province, state, country or area code.
 */
const TOWN = /(?<![a-z])(town|city|dorp)(?![a-z])|suburb|voorstad|address-level2/;
const NOT_TOWN = /address(?!-level2)|adres|street|straat|postal|post.?code|poskode|(?<![a-z])zip|(?<![a-z])(state|code)(?![a-z])|province|provinsie|country|area.?code/;
const COMPANY = /compan|business|organi[sz]ation|\bfirm\b|besigheid|maatskappy/;
const SERVICE_SELECT = /service|reason|interest|enquiry|inquiry|type|department|topic|category|product|regarding|subject/;

/** The role of a text-like field or textarea, by type first, then by what it says it is. */
export function roleOf(f: Pick<FormField, "tag" | "type" | "hint" | "named">): FieldRole | null {
  const h = f.hint;
  if (f.type === "email" || /e-?mail/.test(h)) return "email";
  if (f.type === "tel" || /phone|\btel\b|mobile|cell|whatsapp|contact number|nommer|selfoon/.test(h)) return "phone";
  if (/first.?name|\bfname\b|given.?name|voornaam/.test(h)) return "first";
  if (/last.?name|\blname\b|surname|family.?name|\bvan\b/.test(h)) return "last";
  // The town is read from what the field IS, never its placeholder; "business city" is ambiguous: no role.
  if (TOWN.test(f.named) && COMPANY.test(f.named)) return null;
  if (COMPANY.test(h)) return "company";
  if (/subject|topic|onderwerp/.test(h)) return "subject";
  if (f.tag === "input" && TOWN.test(f.named) && !NOT_TOWN.test(f.named)) return "town";
  if (/address|adres|street|suburb/.test(h)) return null;
  if (f.tag === "textarea" || /message|enquir|inquir|comment|question|details|how can we help|boodskap|vraag/.test(h)) {
    return "message";
  }
  if (/name|naam/.test(h)) return "name";
  return null;
}

/** "Cresta HQ" → first "Cresta", last "HQ"; a one-word name fills both. */
const split = (name: string) => {
  const at = name.indexOf(" ");
  return at === -1 ? [name, name] : [name.slice(0, at), name.slice(at + 1)];
};

const label = (f: FormField) => f.hint.split(" | ").find((s) => s.trim()) || f.key;

export function planFields(fields: FormField[], id: FormIdentity): FieldPlan {
  const trapRequired = fields.find((f) => f.visible && f.trap && f.required);
  if (trapRequired) {
    return { ok: false, code: "honeypot_required", reason: `A required field looks like a trap for bots ("${label(trapRequired)}").` };
  }
  const visible = fields.filter((f) => f.visible && !f.trap && f.type !== "hidden");
  if (visible.some((f) => f.type === "file" && f.required)) {
    return { ok: false, code: "file_upload", reason: "The form requires a file upload." };
  }
  const consent = visible.find((f) => f.required && f.type === "checkbox" && CONSENT.test(f.hint));
  if (consent) {
    return { ok: false, code: "consent_checkbox", reason: `The form requires ticking "${label(consent)}" (accepting terms for the operator).` };
  }
  const [first, last] = split(id.business);
  const values: Record<FieldRole, string | null> = {
    name: id.business, first, last, email: id.email, phone: id.phone, company: id.business,
    subject: id.subject, message: id.message, service: null, town: id.town,
  };
  const fills: Fill[] = [];
  const unmapped: string[] = [];
  for (const f of visible) {
    if (f.tag === "select") {
      const want = id.service.toLowerCase();
      const option = SERVICE_SELECT.test(f.hint) && want
        ? f.options?.find((o) => o.value && (o.text.toLowerCase().includes(want) || (o.text.trim().length > 2 && want.includes(o.text.trim().toLowerCase()))))
        : undefined;
      if (option) fills.push({ key: f.key, role: "service", value: option.value, kind: "select" });
      else if (f.required && !f.value) unmapped.push(label(f));
      continue;
    }
    const textual = f.tag === "textarea" || TEXTLIKE.has(f.type);
    const role = textual ? roleOf(f) : null;
    const value = role ? values[role] : null;
    if (role && value) fills.push({ key: f.key, role, value, kind: "fill" });
    else if (f.required) unmapped.push(label(f));
  }
  if (unmapped.length) {
    return { ok: false, code: "unmapped_required", reason: `Required fields it can't fill: ${unmapped.join(", ")}.` };
  }
  if (!fills.some((f) => f.role === "message")) {
    return { ok: false, code: "unmapped_required", reason: "The form has no message field for the enquiry." };
  }
  return { ok: true, fills, roles: [...new Set(fills.map((f) => f.role))] };
}

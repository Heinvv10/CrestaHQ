/**
 * The one merge-tag renderer (SP2 T4). Pure and isomorphic: the composer, the
 * snippet insert, the review-request insert and the missed-call text-back all
 * render through here.
 *
 * Canonical tags (`{{contact.first_name}}`, `{{business.name}}`, …) report a
 * missing value as UNRESOLVED so a caller can refuse to send a message with a
 * hole in it. Legacy aliases (`{{firstName}}`, `{{businessName}}`,
 * `{{reviewUrl}}`, `{{contact.firstName}}`, `{{workspace.name}}`) keep the
 * behaviour they had as ad-hoc `.replace` chains: a missing value renders as
 * the empty string.
 *
 * Rendering is a single pass over the TEMPLATE, so a value that itself
 * contains `{{…}}` (a contact named "{{business.name}}") is inserted verbatim
 * and never rendered a second time. Tag names are matched case-insensitively
 * and tolerate inner whitespace (`{{ contact.first_name }}`).
 */

export interface MergeTagContext {
  contact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    company?: string | null;
    /** The contact's latest ready prospect report (Prospecting PR 4). */
    prospecting?: {
      lastReportHeadline?: string | null;
      lastReportUrl?: string | null;
    } | null;
  } | null;
  /** The sub-account's name. */
  businessName?: string | null;
  /** The sending member's display name. */
  userName?: string | null;
  /** Legacy `{{reviewUrl}}` only. */
  reviewUrl?: string | null;
}

export interface MergeTagResult {
  text: string;
  /** Tags left without a value, as written in the template, de-duplicated. */
  unresolved: string[];
}

type Resolve = (ctx: MergeTagContext) => string | null | undefined;

function nameWords(ctx: MergeTagContext): string[] {
  const name = (ctx.contact?.name ?? "").trim();
  return name ? name.split(/\s+/) : [];
}

const firstName: Resolve = (ctx) => nameWords(ctx)[0] ?? "";

const CANONICAL: Record<string, Resolve> = {
  "contact.first_name": firstName,
  "contact.last_name": (ctx) => nameWords(ctx).slice(1).join(" "),
  "contact.name": (ctx) => ctx.contact?.name?.trim(),
  "contact.email": (ctx) => ctx.contact?.email,
  "contact.phone": (ctx) => ctx.contact?.phone,
  "contact.company": (ctx) => ctx.contact?.company,
  "business.name": (ctx) => ctx.businessName,
  "user.name": (ctx) => ctx.userName,
  // Keys are matched lower-cased: this is {{prospecting.reportUrl}}.
  "prospecting.headline": (ctx) => ctx.contact?.prospecting?.lastReportHeadline,
  "prospecting.reporturl": (ctx) => ctx.contact?.prospecting?.lastReportUrl,
};

const LEGACY: Record<string, Resolve> = {
  firstname: firstName,
  "contact.firstname": firstName,
  businessname: (ctx) => ctx.businessName,
  "workspace.name": (ctx) => ctx.businessName,
  reviewurl: (ctx) => ctx.reviewUrl,
};

/** Fields the pickers offer, in display order. */
export const MERGE_FIELDS: ReadonlyArray<{ tag: string; label: string }> = [
  { tag: "{{contact.first_name}}", label: "Contact first name" },
  { tag: "{{contact.last_name}}", label: "Contact last name" },
  { tag: "{{contact.name}}", label: "Contact full name" },
  { tag: "{{contact.email}}", label: "Contact email" },
  { tag: "{{contact.phone}}", label: "Contact phone" },
  { tag: "{{contact.company}}", label: "Contact company" },
  { tag: "{{business.name}}", label: "Business name" },
  { tag: "{{user.name}}", label: "Your name" },
  { tag: "{{prospecting.headline}}", label: "Prospect report headline" },
  { tag: "{{prospecting.reportUrl}}", label: "Prospect report link" },
];

// `[^{}]` (not `[^}]`) so "{{{firstName}}}" matches the inner tag, the same
// way the old per-alias regexes did.
const TAG = /\{\{([^{}]*)\}\}/g;

/** Every `{{…}}` left in `text`, as written, de-duplicated, in order. */
export function findMergeTags(text: string): string[] {
  return [...new Set(text.match(TAG) ?? [])];
}

export function renderMergeTags(
  template: string,
  ctx: MergeTagContext,
  opts: { unknown?: "keep" | "drop" } = {}
): MergeTagResult {
  const unresolved: string[] = [];
  const miss = (raw: string) => {
    if (!unresolved.includes(raw)) unresolved.push(raw);
    return opts.unknown === "drop" ? "" : raw;
  };
  // A replacer FUNCTION, so "$&" or "$1" inside a value is inserted literally.
  const text = template.replace(TAG, (raw: string, inner: string) => {
    const key = inner.trim().toLowerCase();
    const canonical = CANONICAL[key];
    if (canonical) {
      const value = canonical(ctx);
      return value && value.trim() ? value : miss(raw);
    }
    const legacy = LEGACY[key];
    if (legacy) return legacy(ctx) ?? "";
    return miss(raw);
  });
  return { text, unresolved };
}

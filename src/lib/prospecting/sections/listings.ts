import "server-only";

import { extractContacts, fetchHomepage } from "@/lib/get-leads/enrich";
import { withReportFetchSlot } from "../fetch-slots";
import type { ProspectReportInput } from "@/types";
import { measured, unavailable, type Homepage, type Scored, type SectionInput } from "./types";

/**
 * Section 4 — listings / NAP. Each directory page is fetched through the
 * shared guarded fetcher (publicFetch, manual redirect hops) inside the
 * reports' fetch pool (fetch-slots.ts), and counts as `found` only when BOTH
 * the normalised business name and phone appear in it.
 *
 * Spike 2026-09-26 (honest UA): Brabys and Cylex answer 403 (Cloudflare
 * block); Yellow Pages SA (yep.co.za) redirects search to a client-rendered
 * shell; Bing returns server-rendered results, but for this UA they were
 * often unrelated (foreign forums for a local business name). So a page with
 * no match is `not_found` (scored, but never a finding) and `listing_missing`
 * is not emitted: no directory here gives a miss we can trust. Blocked,
 * failed, timed-out or near-empty pages are `unknown` and not scored.
 */

export const key = "listings" as const;

export type ListingStatus = "found" | "not_found" | "unknown";

export interface ListingCheck {
  directory: string;
  url: string | null;
  status: ListingStatus;
}

interface Directory {
  name: string;
  url: (business: ProspectReportInput, homepage: Homepage | null) => string | null;
}

const q = encodeURIComponent;

const DIRECTORIES: Directory[] = [
  {
    // Facebook has no keyless search; only the page the website links to is checked.
    name: "Facebook",
    url: (_b, homepage) => (homepage ? extractContacts(homepage.html, homepage.url).facebook : null),
  },
  { name: "Bing", url: (b) => `https://www.bing.com/search?q=${q(`"${b.name}" ${b.city ?? ""}`.trim())}` },
  { name: "Yellow Pages SA", url: (b) => `https://www.yep.co.za/search?what=${q(b.name)}&where=${q(b.city ?? "")}` },
  { name: "Brabys", url: (b) => `https://www.brabys.com/search?q=${q(b.name)}&location=${q(b.city ?? "")}` },
  { name: "Cylex", url: (b) => `https://www.cylex.net.za/s?q=${q(b.name)}&c=${q(b.city ?? "")}` },
];

/** Directory pages run larger than homepages (a Facebook page is ~500 KB). */
const PAGE_MAX_BYTES = 1024 * 1024;

/** Below this much visible text a page is a client-rendered shell, not a result. */
const MIN_TEXT_CHARS = 500;

/** Tag-stripped text, in one linear pass (a regex over an unclosed "<" backtracks). */
function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">" && inTag) {
      inTag = false;
      out += " ";
    } else if (!inTag) out += ch;
  }
  return out;
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/ (pty )?(ltd|cc)$/, "");
}

/** South African numbers: the 9 digits after the leading 0 or +27, else all digits. */
function nationalDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("27")) return digits.slice(2);
  if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Pure: what one fetched page says about the business. Null html = not fetched. */
export function classify(html: string | null, name: string, phone: string): ListingStatus {
  if (html === null) return "unknown";
  const text = stripTags(html);
  if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) return "unknown";
  const nameHit = ` ${normName(text)} `.includes(` ${normName(name)} `);
  const national = nationalDigits(phone);
  const compact = html.replace(/[\s\-().]/g, "");
  const phoneHit =
    national.length === 9
      ? compact.includes(`0${national}`) || compact.includes(`27${national}`)
      : compact.includes(national);
  return nameHit && phoneHit ? "found" : "not_found";
}

export function score(checks: ListingCheck[]): Scored {
  const found = checks.filter((c) => c.status === "found").length;
  const readable = checks.filter((c) => c.status !== "unknown").length;
  return { score: Math.round((found / readable) * 100), findings: [] };
}

export async function run(input: SectionInput) {
  const { business, homepage, signal } = input;
  const phone = business.phone;
  if (!phone || nationalDigits(phone).length < 7) {
    return unavailable(key, "No phone number to match listings against.");
  }
  const checks = await Promise.all(
    DIRECTORIES.map(async (d): Promise<ListingCheck> => {
      const url = d.url(business, homepage);
      if (!url) return { directory: d.name, url: null, status: "unknown" };
      input.count("http");
      const page = await withReportFetchSlot(() => fetchHomepage(url, signal, PAGE_MAX_BYTES), signal);
      return { directory: d.name, url, status: classify(page?.html ?? null, business.name, phone) };
    }),
  );
  if (checks.every((c) => c.status === "unknown")) {
    return unavailable(key, "No directory could be read (blocked, timed out or client-rendered).", { checks });
  }
  return measured(key, score(checks), { checks });
}

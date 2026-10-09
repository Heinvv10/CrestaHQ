import type { ProspectFinding } from "@/types";
// Relative `.ts` imports: scripts/prospecting/backfill-r0b.ts imports this file.
import { finding, scoreOf } from "./findings.ts";
import { detectTech } from "./tech-rules.ts";
import { sameSite } from "../registrable-domain.ts";
import { measured, unavailable, type Scored, type SectionInput } from "./types.ts";

/**
 * Section 10 — the ways a visitor can reach the business from the homepage.
 * Booking and chat come from the shared tech-rules table. All checks are
 * `includes()` on the lower-cased HTML (linear time).
 *
 * `formUrl` (member-only, never in PUBLIC_RAW_KEYS) is where the mystery
 * shop's form engine may go: the homepage itself when it has the form, else
 * the first same-site http(s) link that looks like a contact page. No other
 * page is fetched for the report.
 */

export const key = "lead_capture" as const;

export interface LeadCaptureRaw {
  whatsapp: boolean;
  booking: boolean;
  contactForm: boolean;
  phoneLink: boolean;
  chatWidget: boolean;
}

export type LeadCaptureDetected = LeadCaptureRaw & { formUrl: string | null };

const WHATSAPP_PATTERNS = ["wa.me/", "api.whatsapp.com/send", "whatsapp://"];
const CONTACT_LINK = /contact|enquir|inquir|quote|get-in-touch|get in touch|kontak/i;
// Bounded attribute and text runs, so a hostile page cannot make these quadratic.
const ANCHOR = /<a\b([^>]{0,2000})>([\s\S]{0,500}?)<\/a>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const httpUrl = (raw: string, base?: string): URL | null => {
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/** The first same-site http(s) link whose href or text looks like a contact page. */
function contactLink(html: string, page: URL): string | null {
  for (const [, attrs, inner] of html.matchAll(ANCHOR)) {
    const m = HREF.exec(attrs);
    const href = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").replaceAll("&amp;", "&").trim();
    const text = inner.replace(/<[^>]*>/g, " ");
    if (!href || !(CONTACT_LINK.test(href) || CONTACT_LINK.test(text))) continue;
    const url = httpUrl(href, page.href);
    if (url && sameSite(url.hostname, page.hostname)) return url.href;
  }
  return null;
}

export function detect(html: string, pageUrl?: string): LeadCaptureDetected {
  const page = html.toLowerCase();
  const tech = detectTech(html);
  const formAt = page.indexOf("<form");
  const contactForm =
    formAt !== -1 && (page.indexOf("<input", formAt) !== -1 || page.indexOf("<textarea", formAt) !== -1);
  const at = pageUrl ? httpUrl(pageUrl) : null;
  return {
    whatsapp: WHATSAPP_PATTERNS.some((p) => page.includes(p)),
    booking: tech.some((t) => t.category === "booking"),
    contactForm,
    phoneLink: page.includes('href="tel:') || page.includes("href='tel:"),
    chatWidget: tech.some((t) => t.category === "chat"),
    formUrl: !at ? null : contactForm ? at.href : contactLink(html, at),
  };
}

const CHECKS: [keyof LeadCaptureRaw, ProspectFinding][] = [
  ["whatsapp", finding("no_whatsapp_cta", "The website has no WhatsApp click-to-chat button.")],
  ["booking", finding("no_booking", "The website has no online booking.")],
  ["contactForm", finding("no_contact_form", "The website has no contact form.")],
  ["phoneLink", finding("no_phone_link", "The website has no tap-to-call phone link.")],
  ["chatWidget", finding("no_chat_widget", "The website has no live chat.")],
];

export function score(raw: LeadCaptureRaw): Scored {
  const findings = CHECKS.filter(([field]) => !raw[field]).map(([, f]) => f);
  return { score: scoreOf(findings), findings };
}

export async function run(input: SectionInput) {
  if (!input.business.website) return unavailable(key, "No website to inspect.");
  if (!input.homepage) return unavailable(key, "The website could not be fetched.");
  const raw = detect(input.homepage.html, input.homepage.url);
  return measured(key, score(raw), { ...raw });
}

import type { ProspectFinding } from "@/types";
import { finding, scoreOf } from "./findings.ts";
import { detectTech } from "./tech-rules.ts";
import { measured, unavailable, type Scored, type SectionInput } from "./types.ts";

/**
 * Section 10 — the ways a visitor can reach the business from the homepage.
 * Booking and chat come from the shared tech-rules table. All checks are
 * `includes()` on the lower-cased HTML (linear time).
 */

export const key = "lead_capture" as const;

export interface LeadCaptureRaw {
  whatsapp: boolean;
  booking: boolean;
  contactForm: boolean;
  phoneLink: boolean;
  chatWidget: boolean;
}

const WHATSAPP_PATTERNS = ["wa.me/", "api.whatsapp.com/send", "whatsapp://"];

export function detect(html: string): LeadCaptureRaw {
  const page = html.toLowerCase();
  const tech = detectTech(html);
  const formAt = page.indexOf("<form");
  return {
    whatsapp: WHATSAPP_PATTERNS.some((p) => page.includes(p)),
    booking: tech.some((t) => t.category === "booking"),
    contactForm:
      formAt !== -1 &&
      (page.indexOf("<input", formAt) !== -1 || page.indexOf("<textarea", formAt) !== -1),
    phoneLink: page.includes('href="tel:') || page.includes("href='tel:"),
    chatWidget: tech.some((t) => t.category === "chat"),
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
  const raw = detect(input.homepage.html);
  return measured(key, score(raw), { ...raw });
}

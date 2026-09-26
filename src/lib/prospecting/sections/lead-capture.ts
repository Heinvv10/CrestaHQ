import type { ProspectFinding } from "@/types";
import { detectTech } from "./tech-rules";
import { measured, unavailable, type Scored, type SectionInput } from "./types";

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
  ["whatsapp", { code: "no_whatsapp_cta", text: "The website has no WhatsApp click-to-chat button." }],
  ["booking", { code: "no_booking", text: "The website has no online booking." }],
  ["contactForm", { code: "no_contact_form", text: "The website has no contact form." }],
  ["phoneLink", { code: "no_phone_link", text: "The website has no tap-to-call phone link." }],
  ["chatWidget", { code: "no_chat_widget", text: "The website has no live chat." }],
];

export function score(raw: LeadCaptureRaw): Scored {
  const passed = CHECKS.filter(([field]) => raw[field]).length;
  return {
    score: Math.round((passed / CHECKS.length) * 100),
    findings: CHECKS.filter(([field]) => !raw[field]).map(([, finding]) => finding),
  };
}

export async function run(input: SectionInput) {
  if (!input.business.website) return unavailable(key, "No website to inspect.");
  if (!input.homepage) return unavailable(key, "The website could not be fetched.");
  const raw = detect(input.homepage.html);
  return measured(key, score(raw), { ...raw });
}

import addressparser from "nodemailer/lib/addressparser";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import type { MysteryShopChannel } from "./model";

/**
 * What a mystery shop may contact: only the contact's own values, never
 * something typed in. Email = the contact's email, lower-cased; call and
 * WhatsApp = the contact's phone in E.164 (the contact write paths'
 * normalisation, with the workspace's default country for a bare national
 * number). The report's lead-capture section records only booleans
 * (`phoneLink`, `whatsapp`, no numbers), so it adds no call or WhatsApp
 * targets. Form is not live yet (PR 5c).
 */

/** A plain address only: no quotes, comments, colons or spaces; domain labels joined by dots, ≥ 2 labels. */
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * The target email, lower-cased, when it is a strict plain address that
 * nodemailer's addressparser (the parser the SMTP send uses) reads back as
 * exactly that one address — so what was confirmed is where it goes.
 */
export function normalizeEmailTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !EMAIL.test(v)) return null;
  const parsed = addressparser(v, { flatten: true });
  return parsed.length === 1 && parsed[0]?.address?.toLowerCase() === v ? v : null;
}

export function normalizeTarget(channel: MysteryShopChannel, raw: unknown, country?: string | null): string | null {
  if (channel === "email") return normalizeEmailTarget(raw);
  if (channel === "call" || channel === "whatsapp") return typeof raw === "string" ? normalizePhoneE164(raw, country) : null;
  return null;
}

export function allowedTargets(
  channel: MysteryShopChannel,
  contact: { email?: unknown; phone?: unknown },
  country?: string | null,
): string[] {
  const own = channel === "email" ? contact.email : channel === "call" || channel === "whatsapp" ? contact.phone : null;
  const t = normalizeTarget(channel, own, country);
  return t ? [t] : [];
}

/** The POST's `target`, normalised, when it is one of the allowed ones; else null. */
export function matchTarget(
  channel: MysteryShopChannel,
  raw: unknown,
  allowed: string[],
  country?: string | null,
): string | null {
  const t = normalizeTarget(channel, raw, country);
  return t !== null && allowed.includes(t) ? t : null;
}

/** Mailbox / ISP providers: a shared domain there proves nothing about who sent a reply. */
const PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "me.com", "mac.com", "mail.com", "proton.me", "pm.me", "web.de", "mail.ru", "btinternet.com", "hey.com",
  "telkomsa.net", "mweb.co.za", "iafrica.com", "vodamail.co.za", "webmail.co.za", "absamail.co.za", "afrihost.co.za",
  "cybersmart.co.za", "lantic.net", "polka.co.za", "xsinet.co.za", "global.co.za", "icon.co.za",
]);
/** Provider families under any suffix: gmail.com, hotmail.co.uk, yahoo.co.za, gmx.de … */
const PROVIDER_FAMILIES: ReadonlySet<string> = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "icloud", "aol", "gmx",
  "proton", "protonmail", "zoho", "yandex", "fastmail", "tutanota",
]);
const TWO_LABEL_SUFFIX = /^(co|com|org|net|ac|gov|edu|ltd|plc|web)\.[a-z]{2}$/;

/** Is `domain` (or the registrable domain it sits under) a mailbox / ISP provider? */
export function isProviderDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split(".");
  const take = labels.length >= 3 && TWO_LABEL_SUFFIX.test(labels.slice(-2).join(".")) ? 3 : 2;
  const registrable = labels.slice(-take).join(".");
  return PROVIDER_DOMAINS.has(registrable) || PROVIDER_FAMILIES.has(labels[labels.length - take] ?? "");
}

/**
 * May other addresses at the target's domain answer for the business? Only
 * when that domain is the business's own: its website's host (minus "www."),
 * or a subdomain of it either way — and never a mailbox / ISP provider's
 * domain (a page on biz.mweb.co.za does not make mweb.co.za the business's).
 * The caller passes the server-owned `prospecting.website` only.
 */
export function emailDomainTrusted(email: string, website: unknown): boolean {
  if (typeof website !== "string" || !website.trim()) return false;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`).hostname;
  } catch {
    return false;
  }
  const site = host.toLowerCase().replace(/^www\./, "");
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!site || isProviderDomain(domain) || isProviderDomain(site)) return false;
  return domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`);
}

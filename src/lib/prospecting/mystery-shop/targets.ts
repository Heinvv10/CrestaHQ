import { normalizePhoneE164 } from "@/lib/contacts/phone";
import type { MysteryShopChannel } from "./model";

/**
 * What a mystery shop may contact: only the contact's own values, never
 * something typed in. Email = the contact's email, lower-cased; call = the
 * contact's phone in E.164 (the contact write paths' normalisation, with the
 * workspace's default country for a bare national number). The report's
 * lead-capture section records only booleans (`phoneLink`, no numbers), so it
 * adds no call targets. WhatsApp and form are not live yet (PR 5b / 5c).
 */

// Same shape check as smtp.ts `validEmail` — inlined because smtp.ts is server-only.
const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

export function normalizeEmailTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && EMAIL.test(v) && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
}

export function normalizeTarget(channel: MysteryShopChannel, raw: unknown, country?: string | null): string | null {
  if (channel === "email") return normalizeEmailTarget(raw);
  if (channel === "call") return typeof raw === "string" ? normalizePhoneE164(raw, country) : null;
  return null;
}

export function allowedTargets(
  channel: MysteryShopChannel,
  contact: { email?: unknown; phone?: unknown },
  country?: string | null,
): string[] {
  const own = channel === "email" ? contact.email : channel === "call" ? contact.phone : null;
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

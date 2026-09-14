/**
 * Shared (non-server) constants for the Google review-request feature, so the
 * server-only dispatcher AND the client settings UI can import them.
 */

/** Pre-filled SMS body. Tags: {{firstName}} / {{businessName}} / {{reviewUrl}}. */
export const DEFAULT_REVIEW_SMS_TEMPLATE =
  "Hi {{firstName}}, thanks for choosing {{businessName}}! If you have a moment, a quick Google review would mean a lot: {{reviewUrl}}";

export const DEFAULT_REVIEW_COOLDOWN_DAYS = 90;

/**
 * Review send channel:
 *  - "sms"               — free-form SMS.
 *  - "whatsapp_template" — approved WhatsApp template (compliant outside the 24h
 *                          window; needed for reliable auto-sends).
 *  - "whatsapp_manual"   — free-form WhatsApp, NO template — only works while the
 *                          customer's 24h window is open (e.g. they just messaged
 *                          you). Best used from the unified inbox.
 */
export type ReviewChannel = "sms" | "whatsapp_template" | "whatsapp_manual";

/** Map a stored channel (incl. the legacy 2-option "whatsapp") to a ReviewChannel. */
export function normalizeReviewChannel(
  raw: string | null | undefined,
): ReviewChannel {
  if (raw === "sms" || raw === "whatsapp_template" || raw === "whatsapp_manual") {
    return raw;
  }
  if (raw === "whatsapp") return "whatsapp_template"; // legacy value
  return "sms";
}

/** True for either WhatsApp mode. */
export function isWhatsappReviewChannel(ch: ReviewChannel): boolean {
  return ch === "whatsapp_template" || ch === "whatsapp_manual";
}

/**
 * Review-request reminders (SP5 d2) — GHL's "Until clicked, repeat this every
 * N days / Maximum retries". `everyDays: null` is "Don't repeat": off, the
 * default, and what every config without the field means.
 */
export interface ReviewReminderSettings {
  everyDays: number | null;
  maxRetries: number;
}

export const REMINDER_MAX_EVERY_DAYS = 30;
export const REMINDER_MAX_RETRIES = 5;

const isIntIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Validate a submitted reminder setting; null on anything out of range. */
export function parseReminderSettings(v: unknown): ReviewReminderSettings | null {
  if (!v || typeof v !== "object") return null;
  const { everyDays, maxRetries } = v as Record<string, unknown>;
  if (everyDays !== null && !isIntIn(everyDays, 1, REMINDER_MAX_EVERY_DAYS)) return null;
  if (!isIntIn(maxRetries, 1, REMINDER_MAX_RETRIES)) return null;
  return { everyDays, maxRetries };
}

/** The stored setting when reminders are ON, else null (absent, off, or malformed). */
export function activeReminder(v: unknown): { everyDays: number; maxRetries: number } | null {
  const r = parseReminderSettings(v);
  return r && r.everyDays !== null ? { everyDays: r.everyDays, maxRetries: r.maxRetries } : null;
}

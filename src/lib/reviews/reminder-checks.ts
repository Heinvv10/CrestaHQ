import { createHash } from "node:crypto";

/**
 * Pure checks the review-reminder worker makes before a re-send (SP5 d2),
 * separated so each rule is tested on its own and the worker stays readable.
 */

/** SHA-256 hex of a phone number: stored on a request instead of the number. */
export function phoneHash(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
}

/** SHA-256 hex of the message template a request used — never the body itself. */
export function templateHash(template: string): string {
  return createHash("sha256").update(template).digest("hex");
}

export interface ReminderCheckInput {
  requestId: string;
  req: Record<string, unknown>;
  sub: Record<string, unknown> | null;
  /** null when the contact doc no longer exists. */
  contact: Record<string, unknown> | null;
  /** The contact's other review requests (single-field query on contactId). */
  contactRequests: Array<{ id: string; data: Record<string, unknown> }>;
  /** createdAt (ms) of the contact's most recent INBOUND SMS / WhatsApp messages. */
  inboundAt: number[];
  trackingAvailable: boolean;
  /** The current config's reminder (null = off). */
  reminder: { everyDays: number; maxRetries: number } | null;
  /** The coarse channel the config sends on now. */
  channel: "sms" | "whatsapp";
  /** The configured review URL exists AND is a Google review link. */
  reviewUrlConfigured: boolean;
  /** A dedicated Twilio number (on the shared sender inbound SMS isn't stored, so replies can't be seen). */
  dedicatedSms: boolean;
  /** That number's inbound webhook is set up, so a reply actually reaches us. */
  inboundConfigured: boolean;
  /** Hash of the message template the config would send now. */
  templateHash: string;
}

const ms = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | Date | null | undefined;
  if (t instanceof Date) return t.getTime();
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
};

/**
 * Why this reminder must stop now, before anything is sent — or null. Also the
 * effective maximum: the lower of the request's own and the config's now.
 * Order: the most informative reason first.
 */
export function reminderStopReason(i: ReminderCheckInput): { reason: string | null; maxRetries: number } {
  const r = (i.req.reminder ?? {}) as { attempts?: number; maxRetries?: number };
  const maxRetries = Math.min(r.maxRetries ?? 0, i.reminder?.maxRetries ?? 0);
  const sentAt = ms(i.req.sentAt) ?? 0;
  const cfg = (i.sub?.googleReviewConfig ?? {}) as Record<string, unknown>;
  const others = i.contactRequests.filter((o) => o.id !== i.requestId);
  const since = others.filter((o) => (ms(o.data.sentAt) ?? 0) >= sentAt);
  const trigger = i.req.trigger;
  const autoOff =
    (trigger === "quote_paid" && !(cfg.enabled === true && cfg.triggerOnQuotePaid === true)) ||
    (trigger === "deal_completed" && !(cfg.enabled === true && cfg.triggerOnDealCompleted === true));
  const toHash = typeof i.req.toHash === "string" ? i.req.toHash : null;

  const contact = i.contact;
  // In order, the most informative reason first; the first that holds wins.
  const rules: Array<[string, () => boolean]> = [
    ["clicked", () => !!i.req.clickedAt],
    // A click on ANY of the contact's links after this request went — an older one included.
    ["clicked_other", () => others.some((o) => Math.max(ms(o.data.clickedAt) ?? 0, ms(o.data.lastClickedAt) ?? 0) > sentAt)],
    ["archived", () => i.sub?.status === "archived"],
    ["automations_paused", () => i.sub?.automationsPaused === true],
    ["reminders_off", () => !i.reminder],
    ["auto_send_off", () => autoOff],
    ["not_configured", () => !i.reviewUrlConfigured],
    ["channel_changed", () => i.channel !== i.req.channel],
    ["shared_sender", () => !i.dedicatedSms],
    ["inbound_not_configured", () => !i.inboundConfigured],
    ["template_changed", () => typeof i.req.templateHash === "string" && i.req.templateHash !== i.templateHash],
    ["tracking_unavailable", () => !i.trackingAvailable],
    ["contact_deleted", () => !contact],
    ["phone_changed", () => !!toHash && typeof contact?.phone === "string" && phoneHash(contact.phone) !== toHash],
    ["replied", () => i.inboundAt.some((t) => t > sentAt)],
    ["superseded", () => since.some((o) => (o.data.source ?? "dispatcher") === "dispatcher" && (ms(o.data.sentAt) ?? 0) > sentAt)],
    ["retries_exhausted", () => (r.attempts ?? 0) >= maxRetries],
  ];
  const reason = rules.find(([, holds]) => holds())?.[0] ?? null;
  return { reason, maxRetries };
}

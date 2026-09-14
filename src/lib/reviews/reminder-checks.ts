import { createHash } from "node:crypto";

/**
 * Pure checks the review-reminder worker makes before a re-send (SP5 d2),
 * separated so each rule is tested on its own and the worker stays readable.
 */

/** SHA-256 hex of a phone number: stored on a request instead of the number. */
export function phoneHash(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
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
  reviewUrlConfigured: boolean;
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
  const since = i.contactRequests.filter((o) => o.id !== i.requestId && (ms(o.data.sentAt) ?? 0) >= sentAt);
  const trigger = i.req.trigger;
  const autoOff =
    (trigger === "quote_paid" && !(cfg.enabled === true && cfg.triggerOnQuotePaid === true)) ||
    (trigger === "deal_completed" && !(cfg.enabled === true && cfg.triggerOnDealCompleted === true));
  const toHash = typeof i.req.toHash === "string" ? i.req.toHash : null;

  const reason = i.req.clickedAt
    ? "clicked"
    : since.some((o) => !!o.data.clickedAt)
      ? "clicked_other"
      : i.sub?.status === "archived"
        ? "archived"
        : i.sub?.automationsPaused === true
          ? "automations_paused"
          : !i.reminder
            ? "reminders_off"
            : autoOff
              ? "auto_send_off"
              : !i.reviewUrlConfigured
                ? "not_configured"
                : i.channel !== i.req.channel
                  ? "channel_changed"
                  : !i.trackingAvailable
                    ? "tracking_unavailable"
                    : !i.contact
                      ? "contact_deleted"
                      : toHash && typeof i.contact.phone === "string" && phoneHash(i.contact.phone) !== toHash
                        ? "phone_changed"
                        : i.inboundAt.some((t) => t > sentAt)
                          ? "replied"
                          : since.some((o) => (o.data.source ?? "dispatcher") === "dispatcher" && (ms(o.data.sentAt) ?? 0) > sentAt)
                            ? "superseded"
                            : (r.attempts ?? 0) >= maxRetries
                              ? "retries_exhausted"
                              : null;
  return { reason, maxRetries };
}

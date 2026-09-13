/**
 * A conversation message booked to send later (SP2 T5 "Send later").
 *
 * Stored at `contacts/{contactId}/scheduledMessages/{id}` — beside the thread
 * it belongs to, so it is deleted with the contact. Server-only in both
 * directions: the scheduling API writes it, the QStash worker fires it, and
 * the thread reads it through `GET /api/sub-accounts/[id]/scheduled-messages`.
 *
 * `body` (and `subject`) are FINAL — rendered by the composer when booked. The
 * worker never renders merge tags; it re-runs every send-time check instead.
 */
export type ScheduledMessageStatus =
  | "pending"
  /** Claimed by the worker; the send is in flight (or its outcome unknown). */
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

/** Every channel the composer can send on, except web chat (live-session only). */
export const SCHEDULABLE_CHANNELS = [
  "email",
  "sms",
  "whatsapp",
  "messenger",
  "instagram",
] as const;
export type ScheduledMessageChannel = (typeof SCHEDULABLE_CHANNELS)[number];

/** The latest a message can be booked for. */
export const SCHEDULE_MAX_DAYS = 90;
/** The soonest — anything nearer is "Send now". */
export const SCHEDULE_MIN_LEAD_MS = 60_000;

/** The API's JSON shape — timestamps as ISO strings. */
export interface ScheduledMessageView {
  id: string;
  contactId: string;
  channel: ScheduledMessageChannel;
  body: string;
  subject: string | null;
  sendAt: string;
  status: ScheduledMessageStatus;
  failureReason: string | null;
  failureCode: string | null;
  createdByUid: string;
  createdAt: string | null;
}

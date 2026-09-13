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
  /** Claimed by the worker; the send is in flight (or it crashed mid-send). */
  | "sending"
  | "sent"
  /** Refused before anything went out — certainly not sent. */
  | "failed"
  /**
   * The send was attempted and its outcome is unknown (a provider error or
   * timeout that may have followed delivery). Never shown as "Not sent": the
   * operator must check the conversation before sending it again.
   */
  | "unconfirmed"
  | "cancelled";

/** Statuses an operator can dismiss from the thread (DELETE on a terminal failure). */
export const DISMISSABLE_STATUSES: readonly ScheduledMessageStatus[] = [
  "failed",
  "unconfirmed",
];

/**
 * How late a QStash delivery may arrive and still send. Past this the worker
 * records it as failed ("delivered late") instead: "see you at 3" arriving at
 * 6 is worse than not arriving. The thread shows a pending message past this
 * point as overdue.
 */
export const LATE_DELIVERY_LIMIT_MS = 15 * 60_000;

/**
 * How long a message may sit in "sending" before it is treated as unconfirmed.
 * A send finishes in seconds; one still "sending" after this was claimed by a
 * worker that died mid-send (a deploy restart), so nothing will ever finish
 * it. Its outcome is unknown — the same state as "unconfirmed" — and it can
 * then be dismissed.
 */
export const STALE_SENDING_MS = 15 * 60_000;

/** A "sending" message whose claim (or, lacking one, send time) is older than STALE_SENDING_MS. */
export function isStaleSending(
  m: { status: string; claimedAtMs: number | null; sendAtMs: number },
  nowMs: number
): boolean {
  return m.status === "sending" && nowMs - (m.claimedAtMs ?? m.sendAtMs) > STALE_SENDING_MS;
}
export const LATE_DELIVERY_REASON = "Delivered late by the scheduler — not sent.";
export const UNCONFIRMED_LABEL =
  "Not confirmed sent — check the conversation before resending";

/** Every channel the composer can send on, except web chat (live-session only). */
export const SCHEDULABLE_CHANNELS = [
  "email",
  "sms",
  "whatsapp",
  "messenger",
  "instagram",
] as const;
export type ScheduledMessageChannel = (typeof SCHEDULABLE_CHANNELS)[number];

/**
 * The latest a message can be booked for. 7 days is the maximum QStash delay
 * on Upstash's Free plan, and we cannot confirm production's plan: a longer
 * delay would be refused at publish. Raising it requires confirming the prod
 * QStash plan's max delay (Upstash console → QStash → plan) first, and then
 * changing only this constant (the parser and the picker both read it).
 */
export const SCHEDULE_MAX_DAYS = 7;
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
  /** When the worker claimed it (pending → sending); null until then. */
  claimedAt: string | null;
}

import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Lifecycle of a calendar event. Defaults to `"scheduled"` for legacy
 * events written before this field existed — read via `eventStatus()`
 * which handles the missing-field case so call sites stay clean.
 *
 *   - "scheduled"        — normal, will fire reminders.
 *   - "awaiting_payment" — booking-page hold; PayPal.me deposit gate. Slot is
 *                          busy for availability but no reminders fire.
 *   - "completed"        — operator marked the meeting as done.
 *   - "cancelled"        — operator or visitor cancelled; slot is free.
 *   - "no_show"          — meeting time passed, attendee didn't appear.
 */
export type EventStatus =
  | "scheduled"
  | "awaiting_payment"
  | "completed"
  | "cancelled"
  | "no_show";

/**
 * Origin of an event. Defaults to `"manual"` for legacy events — read
 * via `eventSource()`. Booking-page-created events also fire the
 * `event_booked` automation trigger; manual events do not.
 */
export type EventSource = "manual" | "booking_page";

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: Timestamp | FieldValue | null;
  endAt: Timestamp | FieldValue | null;
  contactId: string | null;
  location: string;
  notes: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  /**
   * Denormalized territory tag, inherited from the linked contact at
   * creation. `null` = standalone event (admin-only triage when scoping
   * is on). Ignored unless `territoryScopingEnabled` is true.
   */
  territoryId?: string | null;
  /**
   * Lifecycle state. Undefined on events created before this field
   * shipped — readers MUST use `eventStatus()` so the default
   * `"scheduled"` is applied consistently.
   */
  status?: EventStatus;
  /**
   * Where the event came from. Undefined on legacy events — readers
   * MUST use `eventSource()` so the default `"manual"` is applied.
   */
  source?: EventSource;
  /**
   * Slug of the booking page that produced this event. Populated only
   * when `source === "booking_page"`. Powers the per-page bookings list
   * and the "view in booking page" deep-link.
   */
  bookingPageSlug?: string | null;
  /**
   * Snapshot of the booking page's `meetingUrl` at booking time. Stays
   * even if the page config later changes its URL. Surfaced in the
   * confirmation + reminder emails and the visitor's /e/[token] page.
   * `null` = no video link (in-person / "we'll send the link separately").
   */
  meetingUrl?: string | null;
  /**
   * SHA-256 hash of the most recent HMAC-signed public token issued for
   * this event. Powers the public /e/[token] view (reschedule / cancel).
   * Mirrors the quotes pattern — raw token never persisted; rotated on
   * every reschedule so old links invalidate cleanly.
   */
  publicTokenHash?: string | null;
  /** True when this event was booked via a page that required payment. */
  paymentRequired?: boolean;
  paymentAmount?: number | null;
  paymentCurrency?: string | null;
  /** PayPal.me URL minted at booking time (stateless URL — no API call). */
  paymentLinkUrl?: string | null;
  /** Set when the operator flips `awaiting_payment` → `scheduled`. */
  paidAt?: Timestamp | FieldValue | null;
  paidByUid?: string | null;
  /**
   * `publicTokenHash` as it was when payment confirmed the booking. Stripe
   * returns the visitor to /e/{that token}?paid=1, so the page accepts it
   * for a read-only "payment received" view — never for manage actions.
   */
  paidFromTokenHash?: string | null;
  /** The Stripe order whose payment confirmed this booking, when one did. */
  paidOrderId?: string | null;
  /** Auto-expire deadline for unpaid holds. Used to schedule the QStash callback. */
  paymentHoldExpiresAt?: Timestamp | FieldValue | null;
  /**
   * Host this booking is assigned to, when the booking page runs in team
   * mode (round-robin). Null on legacy / single-schedule / manual events.
   */
  assignedToUid?: string | null;
  /**
   * Denormalized display name of the assigned host (snapshot at book time)
   * so the internal calendar + ICS feed render the owner without a member
   * lookup. Null when unassigned.
   */
  assignedToName?: string | null;
  /**
   * Collective bookings only: every host in the meeting. The event is busy
   * time for each of them (and for `assignedToUid`, the first host). Absent
   * on every other event. Written by the server only.
   */
  hostUids?: string[] | null;
  /** Service bookings only: the service the visitor picked, snapshotted. */
  serviceId?: string | null;
  serviceName?: string | null;
  /** Set when transitioning to `cancelled`. */
  cancelledAt?: Timestamp | FieldValue | null;
  /** True when the visitor cancelled via /e/[token]; false/undefined when the operator did. */
  cancelledByVisitor?: boolean | null;
  /** Free text or known sentinels: "rescheduled" | "payment_expired" | "operator". */
  cancelReason?: string | null;
  /** Set (and incremented via `rescheduleCount`) on every successful reschedule. */
  rescheduledAt?: Timestamp | FieldValue | null;
  /** Number of times this event has been rescheduled. Undefined/0 = never. */
  rescheduleCount?: number;
  /** SEQUENCE of the last invite update sent; see `nextIcsSequence`. */
  icsSequence?: number;
  /**
   * API-key mode the event was created under. Set only by the v1 API and
   * the server-side manual create; undefined (booking-page, voice, client
   * writes) means live. A `"test"` event must never fire real automations
   * or email — see event-status-service.
   */
  mode?: "live" | "test";
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type EventFormData = {
  title: string;
  startAt: Date;
  endAt: Date;
  contactId: string | null;
  location: string;
  notes: string;
  /**
   * Video-call URL (Zoom / Google Meet / Whereby / etc). Snapshotted onto
   * booking-page events at book time and editable per-event from the
   * calendar dialog. `null` = no link / in-person.
   */
  meetingUrl?: string | null;
};

/**
 * Why a status change or reschedule did NOT email the visitor. Returned by
 * the mark-status and operator reschedule routes so the dialog's toast can
 * say what actually happened instead of assuming the email went out.
 *   - `not_cancelled`         status flip wasn't a cancellation (mark-status only)
 *   - `test_mode`             test-mode event — no real side effects
 *   - `no_contact`            event has no linked contact
 *   - `email_not_configured`  RESEND_API_KEY / EMAIL_FROM missing
 *   - `no_contact_email`      contact record has no email field
 *   - `contact_opted_out`     contact.emailOptedOut === true
 *   - `missing_records`       contact / sub-account doc not found
 *   - `bad_timestamps`        event's startAt/endAt unreadable
 *   - `send_failed`           the send threw
 */
export type EventNotifySkipReason =
  | "not_cancelled"
  | "test_mode"
  | "no_contact"
  | "email_not_configured"
  | "no_contact_email"
  | "contact_opted_out"
  | "missing_records"
  | "bad_timestamps"
  | "send_failed"
  /** An approved agent cancel whose notice no longer matches what was approved. */
  | "changed_since_approval";

/**
 * Read an event's lifecycle status with the legacy default applied.
 * Use this at every status read site so events written before the
 * `status` field shipped continue to behave as if they were `scheduled`.
 */
export function eventStatus(
  e: Pick<CalendarEvent, "status"> | { status?: EventStatus },
): EventStatus {
  return e.status ?? "scheduled";
}

/**
 * Read an event's origin with the legacy default applied. Use this at
 * every source-branch site (e.g. "fire `event_booked` only when source
 * is `booking_page`") so legacy events behave as if they were manual.
 */
export function eventSource(
  e: Pick<CalendarEvent, "source"> | { source?: EventSource },
): EventSource {
  return e.source ?? "manual";
}

/**
 * Does this event status occupy a slot for availability purposes?
 * `scheduled` and `awaiting_payment` are busy; the terminal states
 * (cancelled / completed / no_show) free the slot. Centralised so
 * the availability calculator + UI badges stay in lockstep.
 */
export function eventOccupiesSlot(status: EventStatus): boolean {
  return status === "scheduled" || status === "awaiting_payment";
}

/**
 * Operator-facing display text for a status, matching the GHL vocabulary
 * (Confirmed / Unconfirmed / Showed / No-show / Cancelled). Single source
 * for every status badge/menu in the app — the stored `EventStatus` values
 * are unchanged, this only maps them to copy.
 */
export function eventStatusLabel(status: EventStatus): string {
  switch (status) {
    case "scheduled":
      return "Confirmed";
    case "awaiting_payment":
      return "Unconfirmed (awaiting payment)";
    case "completed":
      return "Showed";
    case "no_show":
      return "No-show";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Every valid `current → next` status flip. Pure + client-safe (no
 * "server-only" dependency) so both the server-side transition gate
 * (lib/server/event-status-service.ts re-exports this) and client UI that
 * needs to know which transitions to offer (e.g. a row action menu) share
 * one table instead of two copies drifting apart.
 *
 *   - `scheduled` → `completed` / `no_show` / `cancelled` allowed.
 *   - `completed` ↔ `no_show` → allowed as a correction either direction.
 *   - `cancelled` is always final.
 *   - `awaiting_payment` → only `cancelled` (use mark-paid to confirm it).
 */
export function isValidStatusTransition(
  current: EventStatus,
  next: EventStatus,
): boolean {
  if (current === next) return true;
  if (current === "cancelled") return false; // always final
  if (current === "completed") return next === "no_show"; // correction
  if (current === "no_show") return next === "completed"; // correction
  if (current === "awaiting_payment") return next === "cancelled";
  // current === "scheduled"
  return next === "completed" || next === "no_show" || next === "cancelled";
}

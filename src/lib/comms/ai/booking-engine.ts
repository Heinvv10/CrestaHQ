import type { SlotCandidate } from "@/lib/booking/availability";
import type { BookingPage } from "@/types/booking";

/**
 * The booking-engine surface the AI booking tools (booking-tools.ts,
 * booking-turn.ts) run on. Type-only: the engine itself is
 * lib/server/agent-booking-service.ts (our resolvePageAvailability +
 * assignBookingHosts core), and channel code passes it in as `engine`.
 * The two slot formatters are pure, so they live here.
 */

/** `messaging` = SMS, WhatsApp, Messenger or Instagram (contact already known). */
export type AgentBookingChannel = "phone" | "web-text" | "web-voice" | "messaging";

export type AgentBookResult =
  | {
      ok: true;
      eventId: string;
      startAt: Date;
      endAt: Date;
      assignedToName: string | null;
    }
  | { ok: false; code: "slot_taken" | "invalid_slot" | "error" };

/** An upcoming booking-page booking the agent may cancel or move. */
export interface ChangeableBooking {
  eventId: string;
  startAt: Date;
  page: BookingPage;
  assignedToUid: string | null;
  assignedToName: string | null;
}

export interface AgentBookingEngine {
  /** Next open slots for a new booking, truncated for a conversational offer. */
  listAgentSlots(
    subAccountId: string,
    page: BookingPage,
    hostUid: string | null,
  ): Promise<SlotCandidate[]>;
  /** Times an existing booking could move to (same re-verify as the move itself). */
  listRescheduleSlots(
    subAccountId: string,
    page: BookingPage,
    event: { id: string; assignedToUid?: string | null },
  ): Promise<SlotCandidate[]>;
}

export type AgentBookingLocationType =
  | "video_link"
  | "google_meet"
  | "in_person"
  | "we_call"
  | "they_call"
  | "their_address";

/**
 * Where the meeting happens, already resolved by the caller from the page
 * (effective location type plus its one-line description).
 */
export interface AgentBookingLocation {
  type: AgentBookingLocationType;
  description: string;
}

/** Spoken-friendly label in the page's timezone, e.g. "Tuesday, July 28 at 10:00 AM". */
export function formatSlotForSpeech(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}

/** Short button label, e.g. "Tue, Oct 28, 10:00 AM", in the page's timezone. */
export function formatSlotForChip(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}

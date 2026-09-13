import { eventOccupiesSlot, eventSource, eventStatus } from "@/types/events";
import type { CalendarEvent, EventStatus } from "@/types/events";

/**
 * Pure predicates for the appointments list (SP3 f) — tabs, the filter
 * panel, and search. Kept separate from the page component so the rules
 * ("what counts as Upcoming") are unit-testable without React or Firestore.
 */

export type AppointmentTab = "upcoming" | "cancelled" | "all";

export interface AppointmentFilters {
  /** One booking page's slug, or null = any (includes manual events). */
  bookingPageSlug: string | null;
  /** One member's uid (the assigned host), or null = any. */
  hostUid: string | null;
  status: EventStatus | null;
  /**
   * `manual` vs `booking_page` only — a voice booking is itself a
   * `booking_page` event (voice-booking-service.ts stamps
   * `source: "booking_page"`, not a distinct value) with no other
   * per-event field marking it voice-originated, so there is no clean
   * third bucket to filter on today.
   */
  source: "booking_page" | "manual" | null;
  /** Inclusive appointment-time range, in epoch ms. Either end optional. */
  fromMs: number | null;
  toMs: number | null;
}

export const EMPTY_APPOINTMENT_FILTERS: AppointmentFilters = {
  bookingPageSlug: null,
  hostUid: null,
  status: null,
  source: null,
  fromMs: null,
  toMs: null,
};

export function hasActiveFilters(filters: AppointmentFilters): boolean {
  return (
    filters.bookingPageSlug !== null ||
    filters.hostUid !== null ||
    filters.status !== null ||
    filters.source !== null ||
    filters.fromMs !== null ||
    filters.toMs !== null
  );
}

function eventStartMs(event: Pick<CalendarEvent, "startAt">): number | null {
  const d = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d.getTime() : null;
}

/**
 * Tab membership. "Upcoming" = still occupying a slot (scheduled or
 * awaiting_payment) AND starting at/after `nowMs` — a past-but-still-
 * "scheduled" booking that hasn't been marked yet falls out of Upcoming
 * once its time passes, matching the bookings-list page's existing
 * "Past" bucket semantics. "Cancelled" is exactly the cancelled status.
 * "All" is unfiltered.
 */
export function matchesTab(
  event: CalendarEvent,
  tab: AppointmentTab,
  nowMs: number,
): boolean {
  if (tab === "all") return true;
  const status = eventStatus(event);
  if (tab === "cancelled") return status === "cancelled";
  // tab === "upcoming"
  const startMs = eventStartMs(event);
  return eventOccupiesSlot(status) && startMs !== null && startMs >= nowMs;
}

export function matchesFilters(
  event: CalendarEvent,
  filters: AppointmentFilters,
): boolean {
  if (
    filters.bookingPageSlug !== null &&
    event.bookingPageSlug !== filters.bookingPageSlug
  ) {
    return false;
  }
  if (filters.hostUid !== null && event.assignedToUid !== filters.hostUid) {
    return false;
  }
  if (filters.status !== null && eventStatus(event) !== filters.status) {
    return false;
  }
  if (filters.source !== null && eventSource(event) !== filters.source) {
    return false;
  }
  const startMs = eventStartMs(event);
  if (filters.fromMs !== null && (startMs === null || startMs < filters.fromMs)) {
    return false;
  }
  if (filters.toMs !== null && (startMs === null || startMs > filters.toMs)) {
    return false;
  }
  return true;
}

/** Title + contact-name search, case-insensitive substring. */
export function matchesSearch(
  event: Pick<CalendarEvent, "title">,
  contactName: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    event.title.toLowerCase().includes(q) ||
    contactName.toLowerCase().includes(q)
  );
}

/** "Calendar" column: the booking page's name, or "Manual". */
export function appointmentCalendarLabel(
  event: Pick<CalendarEvent, "bookingPageSlug">,
  bookingPageNameBySlug: ReadonlyMap<string, string>,
): string {
  if (!event.bookingPageSlug) return "Manual";
  return bookingPageNameBySlug.get(event.bookingPageSlug) ?? event.bookingPageSlug;
}

/**
 * "Owner" column. Only a single assignee is ever denormalized onto an
 * event (`assignedToUid`/`assignedToName`, set by the least-loaded-host
 * pick at book time) — there is no per-event "collective" host list to
 * render, even for a collective-mode booking page.
 */
export function appointmentOwnerLabel(
  event: Pick<CalendarEvent, "assignedToName">,
): string {
  return event.assignedToName || "—";
}

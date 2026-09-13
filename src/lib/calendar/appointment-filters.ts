import { eventHostUids } from "@/lib/booking/page-slots";
import { utcFromWallClock } from "@/lib/booking/availability";
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
  /** One host's uid — matches if they co-host the event (eventHostUids). */
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

export function eventStartMs(event: Pick<CalendarEvent, "startAt">): number | null {
  const d = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d.getTime() : null;
}

/**
 * Tab membership. "Upcoming" = still occupying a slot (scheduled or
 * awaiting_payment) AND starting at/after `nowMs` (a booking starting
 * exactly now still counts) — a past-but-still-"scheduled" booking that
 * hasn't been marked yet falls out of Upcoming once its time passes,
 * matching the bookings-list page's existing "Past" bucket semantics.
 * "Cancelled" is exactly the cancelled status. "All" is unfiltered.
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
  if (filters.hostUid !== null && !eventHostUids(event).includes(filters.hostUid)) {
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

/**
 * Only a booking-page event has a lifecycle to flip — offering
 * Mark completed/no-show/Cancel on a manual event would still email a
 * "visitor" and fire booking.* workflow triggers with nothing behind
 * them (see the operator dialog's BookingActionsPanel, which is
 * gated the same way).
 */
export function canOfferStatusActions(event: Pick<CalendarEvent, "source">): boolean {
  return eventSource(event) === "booking_page";
}

/**
 * "Reschedule" (vs. plain "Edit") only makes sense for a booking-page
 * event that's still holding a slot — a cancelled/completed/no-show
 * booking, or a manual event, gets the generic "Edit" wording instead.
 */
export function canRescheduleAppointment(
  event: Pick<CalendarEvent, "source" | "status">,
): boolean {
  return eventSource(event) === "booking_page" && eventOccupiesSlot(eventStatus(event));
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
 * "Owner" column. Lists every host the event occupies (`eventHostUids` —
 * a collective booking keeps all of its co-hosts), resolved to display
 * names via the sub-account roster; falls back to the event's own
 * denormalized `assignedToName` for a uid the roster doesn't have (a
 * removed member), then "—" when there's no host at all.
 */
export function appointmentOwnerLabel(
  event: Pick<CalendarEvent, "assignedToUid" | "assignedToName" | "hostUids">,
  memberNameByUid: ReadonlyMap<string, string>,
): string {
  const uids = eventHostUids(event);
  if (uids.length === 0) return event.assignedToName || "—";
  const names = uids.map((uid) => {
    if (memberNameByUid.has(uid)) return memberNameByUid.get(uid)!;
    if (uid === event.assignedToUid && event.assignedToName) return event.assignedToName;
    return null;
  });
  const resolved = names.filter((n): n is string => n !== null);
  return resolved.length > 0 ? resolved.join(", ") : event.assignedToName || "—";
}

/**
 * Sort order for the table: Upcoming reads soonest-first (ascending) so
 * the next appointment is at the top; Cancelled and All read most-recent-
 * first (descending) so "Load more" pages further back in time, matching
 * how an operator scans a history list.
 */
export function sortAppointments(
  events: CalendarEvent[],
  tab: AppointmentTab,
): CalendarEvent[] {
  const withMs = events.map((event) => ({ event, ms: eventStartMs(event) ?? 0 }));
  withMs.sort((a, b) => (tab === "upcoming" ? a.ms - b.ms : b.ms - a.ms));
  return withMs.map((x) => x.event);
}

/**
 * Parse a `<input type="date">` value ("YYYY-MM-DD") as the START of that
 * calendar day in `tz`, e.g. the "From" filter: 2026-09-13 in
 * Africa/Johannesburg means 2026-09-13T00:00:00+02:00. Returns null for
 * an empty/unparseable value.
 */
export function dateInputToFromMs(value: string, tz: string): number | null {
  const parts = value.split("-").map(Number);
  const [year, month, day] = parts;
  if (!year || !month || !day || parts.length !== 3) return null;
  return utcFromWallClock(year, month, day, 0, tz).getTime();
}

/**
 * Parse a `<input type="date">` value as the END of that calendar day in
 * `tz`, inclusive — the instant just before the next day's midnight, so a
 * "To" of 2026-09-13 keeps every appointment that starts anywhere in
 * 2026-09-13 local time.
 */
export function dateInputToToMs(value: string, tz: string): number | null {
  const parts = value.split("-").map(Number);
  const [year, month, day] = parts;
  if (!year || !month || !day || parts.length !== 3) return null;
  return utcFromWallClock(year, month, day + 1, 0, tz).getTime() - 1;
}

/**
 * Render an appointment's start time in `tz` — the SAME zone
 * dateInputToFromMs/dateInputToToMs parse the range filter in, so a
 * booking shown as "13 Sep" is also the one a From/To of 2026-09-13
 * matches. A naive `toISOString()`/browser-local render would drift from
 * the filter the moment the viewer isn't in that same zone.
 */
export function formatAppointmentTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

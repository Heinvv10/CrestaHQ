import type { BookingPage, CalendarType } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

/**
 * GHL-style calendar types for booking pages. Client-safe (the editor, the
 * list page and the public view all read it). Slot rules per type live in
 * `page-slots.ts`; this file only names the types.
 */

export const CALENDAR_TYPES: ReadonlyArray<{
  value: CalendarType;
  label: string;
  description: string;
}> = [
  {
    value: "personal",
    label: "Personal",
    description: "One person's calendar. Only their own bookings block it.",
  },
  {
    value: "round_robin",
    label: "Round robin",
    description: "A team shares the page; each booking goes to one free host.",
  },
  {
    value: "class",
    label: "Class",
    description: "Several people book the same slot, up to a seat limit.",
  },
  {
    value: "collective",
    label: "Collective",
    description: "Every host joins; a time is offered only when all are free.",
  },
  {
    value: "service",
    label: "Service",
    description: "Visitors pick a service first; each has its own length.",
  },
];

/**
 * The page's calendar type. Legacy pages carry none and are read as what they
 * already behave like: a page with hosts is round robin (union availability,
 * least-loaded assignment), a hostless page is personal — which, with no host,
 * keeps the old "every event in the sub-account blocks" schedule.
 */
export function pageCalendarType(
  page: Pick<BookingPage, "calendarType" | "hosts">,
): CalendarType {
  if (page.calendarType) return page.calendarType;
  return (page.hosts ?? []).length > 0 ? "round_robin" : "personal";
}

export function calendarTypeLabel(type: CalendarType): string {
  return CALENDAR_TYPES.find((t) => t.value === type)?.label ?? type;
}

/**
 * What a booking's emails, invite and manage page call it, and how long it
 * is. A service booking shows its service and its own length (end − start):
 * the page's `durationMinutes` is only the default for new services. Every
 * other booking keeps the page's name and duration, as before.
 */
export function bookedEventLabel(
  page: Pick<BookingPage, "name" | "durationMinutes"> | null | undefined,
  event: Partial<Pick<CalendarEvent, "title" | "serviceName">>,
  startAt: Date,
  endAt: Date,
): { name: string; durationMinutes: number } {
  const name = page?.name ?? event.title ?? "Meeting";
  const actual = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  if (event.serviceName) {
    return { name: `${name} (${event.serviceName})`, durationMinutes: actual };
  }
  return { name, durationMinutes: page?.durationMinutes ?? Math.max(15, actual) };
}

import {
  computeAvailability,
  groupSlotsByLocalDate,
  type BusyEvent,
  type SlotCandidate,
} from "@/lib/booking/availability";
import { pageCalendarType } from "@/lib/booking/calendar-types";
import type {
  BookingHost,
  BookingPage,
  BookingService,
  WorkingHour,
} from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

/**
 * Pure slot rules per calendar type, on top of the per-schedule calculator in
 * `availability.ts`. The server resolver (`resolve-availability.ts`) loads the
 * busy intervals and calls `computePageSlots`; nothing else should decide
 * which slots a page offers or who gets a booking.
 */

/** A busy interval tagged with who it occupies. */
export interface HostBusy extends BusyEvent {
  /**
   * Hosts this interval blocks. Empty ⇒ shared (a manual whole-business
   * entry): it blocks every host, and every slot on a hostless page.
   */
  hostUids: string[];
  /** Page that booked it — a class page counts its own bookings as seats. */
  bookingPageSlug: string | null;
}

export interface PageSlot extends SlotCandidate {
  /** Hosts free at this slot, in page order. Empty on hostless pages. */
  hostUids: string[];
  /** Class pages only: seats still open at this start. */
  seatsLeft?: number;
}

export interface PageSlotsInput {
  page: BookingPage;
  now: Date;
  fromInstant?: Date;
  toInstant?: Date;
  busy: HostBusy[];
  /** Book-time re-verify of an already-offered slot (voice). See `computeAvailability`. */
  ignoreMinNotice?: boolean;
  /** Named-host selection — pass `selectableHostUid()`'s result, never raw input. */
  onlyHostUid?: string | null;
  /** Reschedule: the booking being moved. Absent ⇒ a new booking. */
  movingEvent?: MovingEvent | null;
  /** Service pages: required; slots are sized to that service. */
  serviceId?: string | null;
}

/**
 * Bounds on a slot length taken from an event rather than a validated page:
 * no service is shorter than 5 min, and the resolver only looks back 8 h for
 * running events, so nothing longer is sized reliably.
 */
export const MIN_SLOT_MINUTES = 5;
export const MAX_SLOT_MINUTES = 8 * 60;

/**
 * A booking being rescheduled. Its slots are its own, whatever the page has
 * become since it was booked:
 *  - with hosts: every one of them must be free (a collective booking keeps
 *    all of its hosts). A host still on the page keeps their own hours; one
 *    no longer on it is checked against their busy on the page hours.
 *    `onlyHostUid` is ignored.
 *  - hostless: the legacy shared schedule — every event blocks, page hours —
 *    because the booking stays shared busy for every host wherever it lands.
 *  - on a service page whose service is gone (or that it pre-dates), it is
 *    sized by its own length.
 */
export interface MovingEvent {
  /** `eventHostUids(event)`. */
  hostUids: string[];
  /** endAt − startAt in whole minutes; 0 when unknown or out of bounds. */
  durationMinutes: number;
}

/** Every host an event occupies: `hostUids` ∪ `assignedToUid`. */
export function eventHostUids(
  e: Pick<CalendarEvent, "assignedToUid" | "hostUids">,
): string[] {
  const out = [...(e.hostUids ?? [])];
  if (e.assignedToUid && !out.includes(e.assignedToUid)) out.push(e.assignedToUid);
  return out;
}

/** Named-host selection applies to pages that assign one host per booking. */
export function hostSelectionEnabled(page: BookingPage): boolean {
  const type = pageCalendarType(page);
  return (
    (type === "round_robin" || type === "service") &&
    (page.hosts ?? []).length > 0 &&
    page.allowHostSelection === true
  );
}

/** A requested host, honoured only on opted-in pages and only for a real host. */
export function selectableHostUid(
  page: BookingPage,
  requested: string | null | undefined,
): string | null {
  if (!requested || !hostSelectionEnabled(page)) return null;
  return (page.hosts ?? []).some((h) => h.uid === requested) ? requested : null;
}

/** The picked service on a service page; null on any other page or unknown id. */
export function pageService(
  page: BookingPage,
  serviceId: string | null | undefined,
): BookingService | null {
  if (pageCalendarType(page) !== "service" || !serviceId) return null;
  return (page.services ?? []).find((s) => s.id === serviceId) ?? null;
}

export function computePageSlots(input: PageSlotsInput): PageSlot[] {
  const { page, movingEvent: moving } = input;
  const type = pageCalendarType(page);

  let sized = page;
  if (type === "service") {
    const minutes =
      pageService(page, input.serviceId)?.durationMinutes ?? moving?.durationMinutes ?? 0;
    if (
      !Number.isInteger(minutes) ||
      !(minutes >= MIN_SLOT_MINUTES && minutes <= MAX_SLOT_MINUTES)
    ) {
      return [];
    }
    sized = { ...page, durationMinutes: minutes };
  }

  // Class pages: the page's own bookings are seats, not busy time.
  const seats = type === "class" ? Math.max(1, page.seatsPerSlot ?? 1) : null;
  const seatBusy =
    seats === null ? [] : input.busy.filter((b) => b.bookingPageSlug === page.slug);
  const busy =
    seats === null ? input.busy : input.busy.filter((b) => b.bookingPageSlug !== page.slug);

  // Collective and class combine per-host results first (intersection, seat
  // count), so the day cap applies after — a slot dropped by that step must
  // not use up the day's allowance. Every other type keeps today's cap inside
  // the calculator (per host in team mode).
  const capAfter = type === "collective" || seats !== null;
  const base = capAfter ? { ...sized, maxPerDay: null } : sized;
  const run = (b: BusyEvent[], hours?: WorkingHour[]) =>
    computeAvailability({
      page: base,
      now: input.now,
      fromInstant: input.fromInstant,
      toInstant: input.toInstant,
      busy: b,
      ignoreMinNotice: input.ignoreMinNotice,
      workingHoursOverride: hours && hours.length > 0 ? hours : undefined,
    });

  let slots: PageSlot[];
  const pageHosts = page.hosts ?? [];
  if (pageHosts.length === 0 || moving?.hostUids.length === 0) {
    // Hostless page, or a hostless booking being moved (see `MovingEvent`):
    // the legacy single shared schedule, where every event blocks.
    slots = run(busy).map((s) => ({ ...s, hostUids: [] }));
  } else {
    const hosts: Array<Pick<BookingHost, "uid" | "workingHours">> = moving
      ? moving.hostUids.map((uid) => pageHosts.find((h) => h.uid === uid) ?? { uid })
      : pageHosts.filter((h) => input.onlyHostUid == null || h.uid === input.onlyHostUid);
    const perHost = hosts.map((h) => ({
      uid: h.uid,
      slots: run(
        busy.filter((b) => b.hostUids.length === 0 || b.hostUids.includes(h.uid)),
        h.workingHours,
      ),
    }));
    slots = combine(perHost, moving || type === "collective" ? "all" : "any");
  }

  if (seats !== null) slots = applySeats(slots, seatBusy, seats);
  if (capAfter && page.maxPerDay != null) {
    const max = page.maxPerDay;
    slots = groupSlotsByLocalDate(slots, page.timezone).flatMap((d) =>
      d.slots.slice(0, max),
    );
  }
  return slots;
}

/**
 * Merge per-host slot lists by start instant. "any" = union (round robin: a
 * slot stays open while any host is free); "all" = intersection (collective).
 */
function combine(
  perHost: Array<{ uid: string; slots: SlotCandidate[] }>,
  mode: "any" | "all",
): PageSlot[] {
  const byStart = new Map<number, PageSlot>();
  for (const { uid, slots } of perHost) {
    for (const s of slots) {
      const key = s.startAt.getTime();
      const hit = byStart.get(key);
      if (hit) hit.hostUids.push(uid);
      else byStart.set(key, { ...s, hostUids: [uid] });
    }
  }
  return [...byStart.values()]
    .filter((s) => mode === "any" || s.hostUids.length === perHost.length)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * Class seats: bookings from this page starting at the slot's exact instant
 * take a seat; one from this page that overlaps at any other start (the page
 * was re-timed since) blocks the slot outright.
 */
function applySeats(slots: PageSlot[], seatBusy: HostBusy[], seats: number): PageSlot[] {
  return slots.flatMap((s) => {
    let taken = 0;
    for (const b of seatBusy) {
      if (b.endAt <= s.startAt || b.startAt >= s.endAt) continue;
      if (b.startAt.getTime() !== s.startAt.getTime()) return [];
      taken++;
    }
    return taken < seats ? [{ ...s, seatsLeft: seats - taken }] : [];
  });
}

/**
 * Pick the host for a one-host booking from those free at the slot (page
 * order). "equal" (default): least loaded, ties → higher priority.
 * "availability": higher priority, ties → least loaded. Remaining ties keep
 * page order (sort is stable). Priority absent ⇒ 2 (medium).
 */
export function pickRoundRobinHost(
  freeHosts: BookingHost[],
  loadByHost: Map<string, number>,
  distribution: BookingPage["distribution"],
): BookingHost | null {
  const load = (h: BookingHost) => loadByHost.get(h.uid) ?? 0;
  const prio = (h: BookingHost) => h.priority ?? 2;
  const byLoad = (a: BookingHost, b: BookingHost) => load(a) - load(b);
  const byPrio = (a: BookingHost, b: BookingHost) => prio(b) - prio(a);
  const ranked = [...freeHosts].sort((a, b) =>
    distribution === "availability"
      ? byPrio(a, b) || byLoad(a, b)
      : byLoad(a, b) || byPrio(a, b),
  );
  return ranked[0] ?? null;
}

export interface HostAssignment {
  assignedToUid: string | null;
  assignedToName: string | null;
  /** Collective only: every host in the meeting. */
  hostUids: string[] | null;
}

/**
 * Who a booking at `slot` belongs to. Null when the page has hosts but none is
 * free (the caller's 409). Collective books every host (first one is the
 * owner); every other hosted type books one host via `pickRoundRobinHost`.
 */
export function assignBookingHosts(
  page: BookingPage,
  slot: PageSlot,
  loadByHost: Map<string, number>,
): HostAssignment | null {
  const pageHosts = page.hosts ?? [];
  if (pageHosts.length === 0) {
    return { assignedToUid: null, assignedToName: null, hostUids: null };
  }
  const free = pageHosts.filter((h) => slot.hostUids.includes(h.uid));
  if (free.length === 0) return null;
  if (pageCalendarType(page) === "collective") {
    return {
      assignedToUid: free[0].uid,
      assignedToName: free[0].name,
      hostUids: free.map((h) => h.uid),
    };
  }
  const chosen = pickRoundRobinHost(free, loadByHost, page.distribution);
  return chosen
    ? { assignedToUid: chosen.uid, assignedToName: chosen.name, hostUids: null }
    : null;
}

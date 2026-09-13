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
  DateOverride,
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
  /**
   * Reschedule: only these hosts (the event's own). Empty/absent ⇒ every page
   * host. A restriction naming no current host yields no slots.
   */
  restrictToHostUids?: string[] | null;
  /** Service pages: required; slots are sized to that service. */
  serviceId?: string | null;
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
  const { page } = input;
  const type = pageCalendarType(page);

  let sized = page;
  if (type === "service") {
    const service = pageService(page, input.serviceId);
    if (!service) return [];
    sized = { ...page, durationMinutes: service.durationMinutes };
  }

  // Buffers: a slot [S, E) needs `bufferBeforeMinutes` free before it and
  // `bufferMinutes` (after) free after it — i.e. [S − before, E + after)
  // must not overlap any busy [s, e). Padding every busy interval to
  // [s − after, e + before) is the same test, and applies to every busy
  // source the resolver feeds in.
  const before = (page.bufferBeforeMinutes ?? 0) * 60_000;
  const after = page.bufferMinutes * 60_000;
  const pad = (b: HostBusy): HostBusy => ({
    ...b,
    startAt: new Date(b.startAt.getTime() - after),
    endAt: new Date(b.endAt.getTime() + before),
  });

  // Class pages: the page's own bookings are seats, not busy time.
  const seats = type === "class" ? Math.max(1, page.seatsPerSlot ?? 1) : null;
  const seatBusy =
    seats === null ? [] : input.busy.filter((b) => b.bookingPageSlug === page.slug);
  const busy = (
    seats === null ? input.busy : input.busy.filter((b) => b.bookingPageSlug !== page.slug)
  ).map(pad);

  // Collective and class combine per-host results first (intersection, seat
  // count), so the day cap applies after — a slot dropped by that step must
  // not use up the day's allowance. Every other type keeps today's cap inside
  // the calculator (per host in team mode).
  const capAfter = type === "collective" || seats !== null;
  const base = capAfter ? { ...sized, maxPerDay: null } : sized;
  const run = (b: BusyEvent[], hours?: WorkingHour[], host?: BookingHost) =>
    computeAvailability({
      page: base,
      now: input.now,
      fromInstant: input.fromInstant,
      toInstant: input.toInstant,
      busy: b,
      ignoreMinNotice: input.ignoreMinNotice,
      workingHoursOverride: hours && hours.length > 0 ? hours : undefined,
      dateOverrides: mergeOverrides(page.dateOverrides, host?.dateOverrides),
    });

  let slots: PageSlot[];
  const pageHosts = page.hosts ?? [];
  if (pageHosts.length === 0) {
    // Hostless (legacy single shared schedule): every event blocks.
    slots = run(busy).map((s) => ({ ...s, hostUids: [] }));
  } else {
    const restrict = input.restrictToHostUids ?? [];
    const hosts = pageHosts.filter(
      (h) =>
        (restrict.length === 0 || restrict.includes(h.uid)) &&
        (input.onlyHostUid == null || h.uid === input.onlyHostUid),
    );
    const perHost = hosts.map((h) => ({
      uid: h.uid,
      slots: run(
        busy.filter((b) => b.hostUids.length === 0 || b.hostUids.includes(h.uid)),
        h.workingHours,
        h,
      ),
    }));
    slots = combine(perHost, type === "collective" ? "all" : "any");
  }

  if (seats !== null) slots = applySeats(slots, seatBusy, seats, pad);
  if (capAfter && page.maxPerDay != null) {
    const max = page.maxPerDay;
    slots = groupSlotsByLocalDate(slots, page.timezone).flatMap((d) =>
      d.slots.slice(0, max),
    );
  }
  return slots;
}

/**
 * One date-override list for a schedule: the host's entry for a date beats
 * the page's; dates neither lists fall back to weekly hours.
 */
function mergeOverrides(
  pageOverrides: DateOverride[] | undefined,
  hostOverrides: DateOverride[] | undefined,
): DateOverride[] {
  const byDate = new Map<string, DateOverride>();
  for (const o of pageOverrides ?? []) byDate.set(o.date, o);
  for (const o of hostOverrides ?? []) byDate.set(o.date, o);
  return [...byDate.values()];
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
 * take a seat; one from this page at any other start blocks the slot when
 * it overlaps it, buffers included (`pad`).
 */
function applySeats(
  slots: PageSlot[],
  seatBusy: HostBusy[],
  seats: number,
  pad: (b: HostBusy) => HostBusy,
): PageSlot[] {
  return slots.flatMap((s) => {
    let taken = 0;
    for (const b of seatBusy) {
      if (b.startAt.getTime() === s.startAt.getTime()) {
        taken++;
        continue;
      }
      const p = pad(b);
      if (p.endAt > s.startAt && p.startAt < s.endAt) return [];
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

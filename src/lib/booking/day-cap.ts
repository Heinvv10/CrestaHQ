import { groupSlotsByLocalDate } from "@/lib/booking/availability";
import type { HostBusy, PageSlot } from "@/lib/booking/page-slots";
import type { BookingPage } from "@/types/booking";

/**
 * "Max per day": once a page holds `maxPerDay` bookings on a local date, it
 * offers nothing more that date. Counts BOOKINGS made on the page, not free
 * slots offered.
 *
 *  - hostless: every booking on the page that date counts.
 *  - with hosts: per host — a host at the cap drops out of the slot, and the
 *    slot goes when none is left, or when it needs every host (`allHosts`:
 *    collective, or a booking being moved) and one is capped.
 *  - class: a session is one start instant; seats in a booked session stay
 *    offered, and a new session opens only while there are fewer than the cap.
 *
 * `own` is this page's bookings from the busy read (the booking being moved
 * is already excluded), which must span the whole local date of each slot.
 */
export function capBookingsPerDay(
  slots: PageSlot[],
  own: HostBusy[],
  page: Pick<BookingPage, "maxPerDay" | "timezone">,
  opts: { allHosts: boolean; isClass: boolean },
): PageSlot[] {
  const max = page.maxPerDay;
  if (max == null) return slots;
  const bookedByDay = new Map(
    groupSlotsByLocalDate(own, page.timezone).map((d) => [d.dateKey, d.slots]),
  );
  return groupSlotsByLocalDate(slots, page.timezone).flatMap(({ dateKey, slots: day }) => {
    const booked = bookedByDay.get(dateKey) ?? [];
    const sessions = new Set(booked.map((b) => b.startAt.getTime()));
    return day.flatMap((s) => {
      if (opts.isClass) {
        return sessions.has(s.startAt.getTime()) || sessions.size < max ? [s] : [];
      }
      if (s.hostUids.length === 0) return booked.length < max ? [s] : [];
      const open = s.hostUids.filter(
        (uid) => booked.filter((b) => b.hostUids.includes(uid)).length < max,
      );
      if (open.length === 0 || (opts.allHosts && open.length < s.hostUids.length)) {
        return [];
      }
      return [{ ...s, hostUids: open }];
    });
  });
}

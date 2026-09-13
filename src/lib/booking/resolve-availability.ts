import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  computePageSlots,
  eventHostUids,
  type HostBusy,
  MAX_SLOT_MINUTES,
  MIN_SLOT_MINUTES,
  type MovingEvent,
  type PageSlot,
  type PageSlotsInput,
} from "@/lib/booking/page-slots";
import { eventOccupiesSlot, eventStatus } from "@/types/events";
import type { CalendarEvent } from "@/types/events";

/**
 * The one place a booking page's slots are computed or re-verified: the
 * public availability API, the book route (inside its transaction), the
 * reschedule route (inside its transaction) and the voice agent all call
 * this. It loads the busy time for the window and applies the page's type
 * and host rules via `computePageSlots`.
 *
 * Busy time is a list of intervals tagged with the hosts they occupy
 * (`HostBusy`), so another source — e.g. a host's external calendar — is
 * passed in as `externalBusy`, tagged with that host, and merges the same way.
 */

/** Busy time from outside LeadStack (e.g. a host's Google calendar). */
export interface ExternalBusy {
  startAt: Date;
  endAt: Date;
  /** Hosts it occupies — see `HostBusy.hostUids` (empty ⇒ everyone). */
  hostUids: string[];
}

export interface ResolveAvailabilityOptions
  extends Omit<PageSlotsInput, "busy" | "now" | "movingEvent"> {
  subAccountId: string;
  /** Defaults to the current instant. */
  now?: Date;
  /**
   * Reschedule: the booking being moved — never counted as busy, and slots
   * are its own (`MovingEvent`). Build it with `movingEventOf` from an event
   * the caller has checked belongs to this page.
   */
  movingEvent?: (MovingEvent & { id: string }) | null;
  /**
   * Pre-loaded external busy time. Load it OUTSIDE any transaction: an
   * external call inside one is repeated on every contention retry.
   */
  externalBusy?: ExternalBusy[];
  /**
   * Read busy events inside this transaction, so a book/reschedule write
   * conflicts with any concurrent booking that changes what it read.
   */
  txn?: FirebaseFirestore.Transaction;
}

/** The busy-events query failed (typically a missing composite index). */
export class BusyQueryError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : "busy query failed");
  }
}

// Look back by the longest plausible single event so one that started
// before the window but is still running is seen as busy.
const BUSY_LOOKBACK_MS = MAX_SLOT_MINUTES * 60_000;

export async function resolvePageAvailability(
  opts: ResolveAvailabilityOptions,
): Promise<PageSlot[]> {
  const now = opts.now ?? new Date();
  const queryFrom = new Date(
    (opts.fromInstant ?? now).getTime() - BUSY_LOOKBACK_MS,
  );
  const queryTo =
    opts.toInstant ??
    new Date(now.getTime() + opts.page.visibleDays * 24 * 60 * 60_000);

  const busy = await loadEventBusy(
    opts.subAccountId,
    queryFrom,
    queryTo,
    opts.movingEvent?.id ?? null,
    opts.txn,
  );
  for (const b of opts.externalBusy ?? []) {
    busy.push({ ...b, bookingPageSlug: null });
  }

  return computePageSlots({
    page: opts.page,
    now,
    fromInstant: opts.fromInstant,
    toInstant: opts.toInstant,
    busy,
    ignoreMinNotice: opts.ignoreMinNotice,
    onlyHostUid: opts.onlyHostUid,
    movingEvent: opts.movingEvent,
    serviceId: opts.serviceId,
  });
}

/** The `movingEvent` for a booking being rescheduled. */
export function movingEventOf(
  id: string,
  e: CalendarEvent,
): MovingEvent & { id: string } {
  const start = toDate(e.startAt);
  const end = toDate(e.endAt);
  const minutes = start && end ? (end.getTime() - start.getTime()) / 60_000 : 0;
  // Events are client-writable, so the length is untrusted: anything but a
  // whole number of minutes in bounds is unknown (0), and a service page then
  // offers nothing rather than size slots by it.
  const ok =
    Number.isInteger(minutes) &&
    minutes >= MIN_SLOT_MINUTES &&
    minutes <= MAX_SLOT_MINUTES;
  return { id, hostUids: eventHostUids(e), durationMinutes: ok ? minutes : 0 };
}

/** Occupying events in the sub-account starting inside [from, to]. */
async function loadEventBusy(
  subAccountId: string,
  from: Date,
  to: Date,
  excludeEventId: string | null,
  txn: FirebaseFirestore.Transaction | undefined,
): Promise<HostBusy[]> {
  const query = getAdminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("startAt", ">=", from)
    .where("startAt", "<=", to);
  let snap: FirebaseFirestore.QuerySnapshot;
  try {
    snap = txn ? await txn.get(query) : await query.get();
  } catch (err) {
    // Only outside a transaction: inside one, the error must reach
    // runTransaction untouched so its contention retry still works.
    if (txn) throw err;
    throw new BusyQueryError(err);
  }

  const out: HostBusy[] = [];
  for (const d of snap.docs) {
    if (d.id === excludeEventId) continue;
    const e = d.data() as CalendarEvent;
    if (!eventOccupiesSlot(eventStatus(e))) continue;
    // Skip malformed timestamps so one bad doc can't break every slot.
    const startAt = toDate(e.startAt);
    const endAt = toDate(e.endAt);
    if (!startAt || !endAt) continue;
    out.push({
      startAt,
      endAt,
      hostUids: eventHostUids(e),
      bookingPageSlug: e.bookingPageSlug ?? null,
    });
  }
  return out;
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const d = (v as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d : null;
}

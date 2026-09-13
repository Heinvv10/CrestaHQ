import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  computePageSlots,
  eventHostUids,
  type HostBusy,
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
 * (`HostBusy`), so another source — e.g. a host's external calendar — adds
 * intervals here, tagged with that host, and no caller changes.
 */

export interface ResolveAvailabilityOptions
  extends Omit<PageSlotsInput, "busy" | "now"> {
  subAccountId: string;
  /** Defaults to the current instant. */
  now?: Date;
  /** Never counted as busy — the event being rescheduled. */
  excludeEventId?: string | null;
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
// before the window but is still running is seen as busy. (It also covers
// the before-buffer, which pads busy intervals forward by at most 60 min.)
const BUSY_LOOKBACK_MS = 8 * 60 * 60_000;

export async function resolvePageAvailability(
  opts: ResolveAvailabilityOptions,
): Promise<PageSlot[]> {
  const now = opts.now ?? new Date();
  const queryFrom = new Date(
    (opts.fromInstant ?? now).getTime() - BUSY_LOOKBACK_MS,
  );
  // Read past the window by the widest buffer: an event starting inside the
  // last slot's after-buffer (or a same-page booking whose before-buffer
  // reaches back into it) still blocks it.
  const padMinutes = Math.max(
    opts.page.bufferMinutes,
    opts.page.bufferBeforeMinutes ?? 0,
  );
  const queryTo = new Date(
    (
      opts.toInstant ??
      new Date(now.getTime() + opts.page.visibleDays * 24 * 60 * 60_000)
    ).getTime() +
      padMinutes * 60_000,
  );

  const busy = await loadEventBusy(
    opts.subAccountId,
    queryFrom,
    queryTo,
    opts.excludeEventId ?? null,
    opts.txn,
  );

  return computePageSlots({
    page: opts.page,
    now,
    fromInstant: opts.fromInstant,
    toInstant: opts.toInstant,
    busy,
    ignoreMinNotice: opts.ignoreMinNotice,
    onlyHostUid: opts.onlyHostUid,
    restrictToHostUids: opts.restrictToHostUids,
    serviceId: opts.serviceId,
  });
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

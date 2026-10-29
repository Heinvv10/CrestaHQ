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
import { eventOccupiesSlot, eventStatus, isImportedEvent } from "@/types/events";
import type { CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { SubAccountMemberDoc } from "@/types/tenancy";

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

// The main busy read ranges on `startAt`, so it looks back 26 h: far enough
// for the start of the window's first local date (the day cap counts bookings
// on the whole date) and for any slot-sized event still running. Events
// longer than 8 h are read by a second query on `isLong` — see long-event.ts.
const BUSY_LOOKBACK_MS = 26 * 60 * 60_000;
// The day cap counts the page's bookings on a slot's whole local date, so
// with a cap the read runs to the end of the window's last local date too.
const DAY_CAP_LOOKAHEAD_MS = 26 * 60 * 60_000;
// How far back the long-event query reaches. A longer-running event that
// began before this is missed.
const LONG_LOOKBACK_MS = 366 * 24 * 60 * 60_000;

export async function resolvePageAvailability(
  opts: ResolveAvailabilityOptions,
): Promise<PageSlot[]> {
  const now = opts.now ?? new Date();
  // Buffers pad busy time by up to the wider buffer on either side, so read
  // that much further both ways: an event ending just before the window
  // (before-buffer), or starting just after it (after-buffer, or a
  // same-page booking's before-buffer), still blocks a slot inside it.
  const padMs =
    Math.max(opts.page.bufferMinutes, opts.page.bufferBeforeMinutes ?? 0) *
    60_000;
  const queryFrom = new Date(
    (opts.fromInstant ?? now).getTime() - BUSY_LOOKBACK_MS - padMs,
  );
  const queryTo = new Date(
    (
      opts.toInstant ??
      new Date(now.getTime() + opts.page.visibleDays * 24 * 60 * 60_000)
    ).getTime() +
      padMs +
      (opts.page.maxPerDay != null ? DAY_CAP_LOOKAHEAD_MS : 0),
  );

  const { busy, pageBookings } = await loadEventBusy(
    opts.subAccountId,
    opts.page.slug,
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
    pageBookings,
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

/**
 * Reschedule: a host of the booking who is off the page AND no longer an
 * active member. Their page hours must not be offered for someone who has
 * left, so the caller refuses with this message (409). Null when every host
 * is on the page or still active — or the page is hostless, where the
 * booking is on the shared schedule anyway.
 */
export async function departedHostMessage(
  page: Pick<BookingPage, "hosts">,
  event: CalendarEvent,
): Promise<string | null> {
  const onPage = new Set((page.hosts ?? []).map((h) => h.uid));
  if (onPage.size === 0) return null;
  for (const uid of eventHostUids(event)) {
    if (onPage.has(uid)) continue;
    // Events are client-writable: a uid that isn't one path segment would
    // make `.doc()` throw. It can't name an active member, so it's refused.
    const readable = typeof uid === "string" && uid !== "" && !uid.includes("/");
    const snap = readable
      ? await getAdminDb()
          .doc(`subAccounts/${event.subAccountId}/subAccountMembers/${uid}`)
          .get()
      : null;
    if ((snap?.data() as SubAccountMemberDoc | undefined)?.status === "active") continue;
    const who =
      uid === event.assignedToUid && event.assignedToName
        ? event.assignedToName
        : "Your host";
    return `${who} is no longer available — please contact the business to rebook.`;
  }
  return null;
}

/**
 * Occupying events in the sub-account starting inside [from, to], plus long
 * events (`isLong`) that began up to `LONG_LOOKBACK_MS` earlier; and this
 * page's bookings in the same read that the day cap counts — every status
 * but cancelled, since a completed or no-show booking still used the day.
 */
async function loadEventBusy(
  subAccountId: string,
  pageSlug: string,
  from: Date,
  to: Date,
  excludeEventId: string | null,
  txn: FirebaseFirestore.Transaction | undefined,
): Promise<{ busy: HostBusy[]; pageBookings: HostBusy[] }> {
  const events = getAdminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId);
  const query = events.where("startAt", ">=", from).where("startAt", "<=", to);
  let snap: FirebaseFirestore.QuerySnapshot;
  try {
    snap = txn ? await txn.get(query) : await query.get();
  } catch (err) {
    // Only outside a transaction: inside one, the error must reach
    // runTransaction untouched so its contention retry still works.
    if (txn) throw err;
    throw new BusyQueryError(err);
  }
  // Read OUTSIDE the transaction even when there is one, so a book or
  // reschedule doesn't read-lock months of old events. It needs no conflict
  // detection: what the transaction guards against is a concurrent booking,
  // and bookings are slot-sized (never `isLong`), so they are in the main
  // read above. A long event added mid-transaction from the dashboard isn't
  // availability-checked anyway.
  const longDocs = await loadLongEvents(
    events
      .where("isLong", "==", true)
      .where("startAt", ">=", new Date(from.getTime() - LONG_LOOKBACK_MS))
      .where("startAt", "<=", to),
    txn !== undefined,
  );

  const busy: HostBusy[] = [];
  const pageBookings: HostBusy[] = [];
  const seen = new Set<string>();
  for (const d of [...snap.docs, ...longDocs]) {
    if (d.id === excludeEventId || seen.has(d.id)) continue;
    seen.add(d.id);
    const e = d.data() as CalendarEvent;
    // Imported Google events: the hosts' Google busy already covers them, and
    // with no host on them they would block every host.
    if (isImportedEvent(e)) continue;
    // Skip malformed timestamps so one bad doc can't break every slot.
    const startAt = toDate(e.startAt);
    const endAt = toDate(e.endAt);
    if (!startAt || !endAt) continue;
    const status = eventStatus(e);
    const entry: HostBusy = {
      startAt,
      endAt,
      hostUids: eventHostUids(e),
      bookingPageSlug: e.bookingPageSlug ?? null,
    };
    if (eventOccupiesSlot(status)) busy.push(entry);
    if (entry.bookingPageSlug === pageSlug && status !== "cancelled") {
      pageBookings.push(entry);
    }
  }
  return { busy, pageBookings };
}

let longIndexMissingLogged = false;

/**
 * The long-event query needs the `(subAccountId, isLong, startAt)` index. Until
 * it is deployed (and existing events backfilled) it fails SOFT — no long
 * events, logged once — so availability is never worse than the short read.
 */
async function loadLongEvents(
  query: FirebaseFirestore.Query,
  inTxn: boolean,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  try {
    return (await query.get()).docs;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e?.code === 9 || String(e?.message ?? "").includes("FAILED_PRECONDITION")) {
      if (!longIndexMissingLogged) {
        longIndexMissingLogged = true;
        console.warn(
          "[resolve-availability] long-event index missing — long events not read until firestore.indexes.json is deployed",
        );
      }
      return [];
    }
    if (inTxn) throw err;
    throw new BusyQueryError(err);
  }
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const d = (v as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d : null;
}

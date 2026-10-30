import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { utcFromWallClock } from "@/lib/booking/availability";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import { eventHostUids } from "@/lib/booking/page-slots";
import {
  activeGoogleHosts,
  gcalConnectionPath,
  readConnection,
  recordConnectionError,
  withBudget,
  withGoogleToken,
} from "./connection";
import { googleCalendarGateOn } from "./gate";
import { getGcalProviderFor } from "./provider/select";
import type { GcalEvent, GcalEventList, GcalEventTime } from "./provider/types";

/**
 * Google busy time for booking-page hosts (G2).
 *
 * Called OUTSIDE any Firestore transaction — a Google round trip inside one
 * would hold the transaction open for seconds. FAILS OPEN (ruling 8): a host
 * whose Google errors, times out or is revoked contributes no busy time and
 * gets the failure recorded on their connection, where their card shows it.
 * A Google outage must never take the booking page offline.
 */

export interface GoogleBusyInterval {
  startAt: Date;
  endAt: Date;
  /** The host(s) this interval blocks. */
  hostUids: string[];
}

/** Per-host budget for the whole Google leg (refresh + list). */
export const GOOGLE_BUSY_TIMEOUT_MS = 3_000;

/** An instant from Google's `dateTime`, or the start of an all-day `date` in the calendar's zone. */
export function instant(t: GcalEventTime | undefined, calendarTz: string): Date | null {
  if (t?.dateTime) {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = t?.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date) : null;
  if (!m) return null;
  return utcFromWallClock(Number(m[1]), Number(m[2]), Number(m[3]), 0, t?.timeZone ?? calendarTz);
}

/** True when the event actually occupies the member's time (the calendar import uses the same rule). */
export function isBusy(e: GcalEvent): boolean {
  if (e.status === "cancelled") return false;
  if (e.transparency === "transparent") return false;
  // Our own bookings are already busy in Firestore; counting their Google
  // copy too would block a rescheduling attendee from their own slot.
  if (e.extendedProperties?.private?.leadstackEventId) return false;
  if (e.attendees?.find((a) => a.self)?.responseStatus === "declined") return false;
  return true;
}

/** Pure: one host's Google events → busy intervals. */
export function busyFromGoogleEvents(list: GcalEventList, uid: string): GoogleBusyInterval[] {
  const tz = list.timeZone ?? "UTC";
  const out: GoogleBusyInterval[] = [];
  for (const e of list.items) {
    if (!isBusy(e)) continue;
    const startAt = instant(e.start, tz);
    const endAt = instant(e.end, tz);
    if (!startAt || !endAt || endAt <= startAt) continue;
    out.push({ startAt, endAt, hostUids: [uid] });
  }
  return out;
}

async function hostBusy(
  subAccountId: string,
  uid: string,
  window: { timeMin: Date; timeMax: Date },
): Promise<GoogleBusyInterval[]> {
  try {
    return await withBudget(GOOGLE_BUSY_TIMEOUT_MS, async (signal) => {
      const conn = await readConnection(subAccountId, uid);
      if (!conn || conn.status !== "connected") return [];
      const provider = await getGcalProviderFor(subAccountId, uid);
      const list = await withGoogleToken(conn, provider, (t) => provider.listEvents(t, window, signal), signal);
      // A read that works again clears the warning a failed read left — never
      // once the budget expired (the timeout's error is the newer truth), and
      // never a push error.
      if (conn.lastError && !signal.aborted) {
        await getAdminDb()
          .doc(gcalConnectionPath(subAccountId, uid))
          .update({ lastError: null, lastErrorAt: null });
      }
      return busyFromGoogleEvents(list, uid);
    });
  } catch (err) {
    const kind = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.warn(`[google-calendar] busy skipped (fail open) sa=${subAccountId} uid=${uid}`, kind);
    await recordConnectionError(subAccountId, uid, err);
    return [];
  }
}

/**
 * Google busy time for `hostUids` over [from, to). Empty when there are no
 * hosts (a hostless page has no one to read — ruling 2) or the gate is off.
 */
export async function loadGoogleBusy(input: {
  subAccountId: string;
  hostUids: string[];
  from: Date;
  to: Date;
}): Promise<GoogleBusyInterval[]> {
  if (input.hostUids.length === 0) return [];
  try {
    if (!(await googleCalendarGateOn(input.subAccountId))) return [];
  } catch (err) {
    console.warn(`[google-calendar] gate read failed (fail open) sa=${input.subAccountId}`, err);
    return [];
  }
  // A removed member's connection is never read (their doc is deleted on
  // removal; this covers anything left behind).
  let uids: string[];
  try {
    uids = await activeGoogleHosts(input.subAccountId, input.hostUids);
  } catch (err) {
    console.warn(`[google-calendar] host check failed (fail open) sa=${input.subAccountId}`, err);
    return [];
  }
  const window = { timeMin: input.from, timeMax: input.to };
  const perHost = await Promise.all(uids.map((uid) => hostBusy(input.subAccountId, uid, window)));
  return perHost.flat();
}

/**
 * Google busy for a booking page's hosts — the resolver's `externalBusy`.
 * Load it OUTSIDE any transaction. The Google read window is the resolver's
 * (same defaults, padded by the page's buffers) CLAMPED to the page's own
 * horizon, so a public caller's `from`/`to` can never make us read a host's
 * calendar outside [now − pad, now + visibleDays + pad]. `extraHostUids`:
 * the moving event's own hosts on a reschedule (a host taken off the page
 * but still active keeps their booking — and their Google busy).
 */
export async function loadGoogleBusyForPage(input: {
  subAccountId: string;
  page: BookingPage;
  now?: Date;
  fromInstant?: Date;
  toInstant?: Date;
  extraHostUids?: string[];
}): Promise<GoogleBusyInterval[]> {
  const { page } = input;
  const now = input.now ?? new Date();
  const padMs = Math.max(page.bufferMinutes ?? 0, page.bufferBeforeMinutes ?? 0) * 60_000;
  const floor = now.getTime() - padMs;
  const ceiling = now.getTime() + page.visibleDays * 24 * 60 * 60_000 + padMs;
  const from = Math.max(floor, (input.fromInstant ?? now).getTime() - padMs);
  const to = Math.min(ceiling, (input.toInstant ?? new Date(ceiling)).getTime() + padMs);
  if (!(to > from)) return [];
  return loadGoogleBusy({
    subAccountId: input.subAccountId,
    hostUids: [...(page.hosts ?? []).map((h) => h.uid), ...(input.extraHostUids ?? [])],
    from: new Date(from),
    to: new Date(to),
  });
}

/**
 * Reschedule: the page is read inside the caller's transaction, so this
 * pre-reads the event and its page to load Google busy before it. Fail open.
 */
export async function loadGoogleBusyForEvent(
  eventId: string,
  fromInstant: Date,
  toInstant: Date,
): Promise<GoogleBusyInterval[]> {
  try {
    const db = getAdminDb();
    const e = (await db.collection("events").doc(eventId).get()).data() as CalendarEvent | undefined;
    if (!e?.subAccountId || !e.bookingPageSlug) return [];
    const pageSnap = await db.doc(`subAccounts/${e.subAccountId}/bookingPages/${e.bookingPageSlug}`).get();
    if (!pageSnap.exists) return [];
    return await loadGoogleBusyForPage({
      subAccountId: e.subAccountId,
      page: pageSnap.data() as BookingPage,
      fromInstant,
      toInstant,
      extraHostUids: eventHostUids(e),
    });
  } catch (err) {
    console.warn(`[google-calendar] event busy skipped (fail open) event=${eventId}`, err);
    return [];
  }
}

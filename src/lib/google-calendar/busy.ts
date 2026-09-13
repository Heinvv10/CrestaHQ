import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  utcFromWallClock,
  type BusyEvent,
  type BusyEventWithHost,
} from "@/lib/booking/availability";
import type { CalendarEvent } from "@/types/events";
import {
  GoogleCalendarTimeoutError,
  gcalConnectionPath,
  readConnection,
  recordConnectionError,
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

function withTimeout<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GoogleCalendarTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** An instant from Google's `dateTime`, or the start of an all-day `date` in the calendar's zone. */
function instant(t: GcalEventTime | undefined, calendarTz: string): Date | null {
  if (t?.dateTime) {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = t?.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date) : null;
  if (!m) return null;
  return utcFromWallClock(Number(m[1]), Number(m[2]), Number(m[3]), 0, t?.timeZone ?? calendarTz);
}

/** True when the event actually occupies the member's time. */
function isBusy(e: GcalEvent): boolean {
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
    return await withTimeout(
      GOOGLE_BUSY_TIMEOUT_MS,
      (async () => {
        const conn = await readConnection(subAccountId, uid);
        if (!conn || conn.status !== "connected") return [];
        const provider = await getGcalProviderFor(subAccountId, uid);
        const list = await withGoogleToken(conn, provider, (t) => provider.listEvents(t, window));
        // A read that works again clears the warning a failed one left.
        if (conn.lastError) {
          await getAdminDb()
            .doc(gcalConnectionPath(subAccountId, uid))
            .update({ lastError: null, lastErrorAt: null });
        }
        return busyFromGoogleEvents(list, uid);
      })(),
    );
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
  const uids = [...new Set(input.hostUids)];
  if (uids.length === 0) return [];
  try {
    if (!(await googleCalendarGateOn(input.subAccountId))) return [];
  } catch (err) {
    console.warn(`[google-calendar] gate read failed (fail open) sa=${input.subAccountId}`, err);
    return [];
  }
  const window = { timeMin: input.from, timeMax: input.to };
  const perHost = await Promise.all(uids.map((uid) => hostBusy(input.subAccountId, uid, window)));
  return perHost.flat();
}

/** The same intervals in the host-tagged shape today's availability callers build. */
export function asHostBusy(busy: GoogleBusyInterval[]): BusyEventWithHost[] {
  return busy.flatMap((b) =>
    b.hostUids.map((uid) => ({ startAt: b.startAt, endAt: b.endAt, assignedToUid: uid })),
  );
}

/** Add host-tagged Google busy into a per-host busy map (the book/voice re-verify shape). */
export function mergeHostBusy(
  byHost: Map<string, BusyEvent[]>,
  busy: GoogleBusyInterval[],
): void {
  for (const b of asHostBusy(busy)) {
    const uid = b.assignedToUid as string;
    byHost.set(uid, [...(byHost.get(uid) ?? []), { startAt: b.startAt, endAt: b.endAt }]);
  }
}

/** Google busy for the hosts of an existing event, around a new slot (reschedule). */
export async function loadGoogleBusyForEvent(
  eventId: string,
  from: Date,
  to: Date,
): Promise<GoogleBusyInterval[]> {
  try {
    const snap = await getAdminDb().collection("events").doc(eventId).get();
    const e = snap.data() as (CalendarEvent & { hostUids?: unknown }) | undefined;
    if (!e?.subAccountId) return [];
    const hostUids = Array.isArray(e.hostUids)
      ? e.hostUids.filter((u): u is string => typeof u === "string")
      : e.assignedToUid
        ? [e.assignedToUid]
        : [];
    return await loadGoogleBusy({ subAccountId: e.subAccountId, hostUids, from, to });
  } catch (err) {
    console.warn(`[google-calendar] event busy skipped (fail open) event=${eventId}`, err);
    return [];
  }
}

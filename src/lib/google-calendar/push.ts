import "server-only";

import crypto from "node:crypto";
import { after } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { eventHostUids } from "@/lib/booking/page-slots";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import type { BookingPage } from "@/types/booking";
import { eventOccupiesSlot, eventStatus, type CalendarEvent } from "@/types/events";
import {
  describeFailure,
  gcalConnectionPath,
  isActiveMember,
  readConnection,
  recordConnectionError,
  withBudget,
  withGoogleToken,
} from "./connection";
import { googleCalendarGateOn } from "./gate";
import { getGcalProviderFor } from "./provider/select";
import type { GcalEventInput } from "./provider/types";

/**
 * Mirror one booking into its hosts' primary Google calendars (G3).
 *
 * Reads the event AFTER the caller's commit and converges Google to it: an
 * occupying event (scheduled / awaiting payment) is written for every
 * eligible host; a cancelled one — and any host no longer on the event — has
 * its Google copy deleted. Completed / no-show events are left alone.
 *
 * Eligible hosts (S1): the event's hosts that are ACTIVE members AND either
 * a current host of its booking page or on its server-set `hostUids`. A
 * hostless page, or a manual event, pushes nowhere. Anyone else is skipped
 * and the skip is recorded on the event.
 *
 * Writes use a deterministic Google id per (event, host) and are idempotent,
 * so racing pushes can't duplicate. After the Google calls the event is read
 * again; if its status, time or hosts moved meanwhile, it converges once more.
 *
 * Best-effort: never throws into the caller. Failures go to the event
 * (`googleSyncError`, shown in the event dialog with Retry sync) and to the
 * host's connection (`lastPushError`).
 */

/** Server-only fields on `events/{id}` (firestore.rules locks them from clients). */
export interface GoogleSyncFields {
  /** Host uid → the Google event id written to that host's primary calendar. */
  googleEventIds?: Record<string, string> | null;
  googleSyncError?: { message: string; at: Date } | null;
}

type SyncedEvent = CalendarEvent & GoogleSyncFields;

/** Per-host budget for the whole Google leg, token refresh included. */
export const GOOGLE_PUSH_TIMEOUT_MS = 5_000;

/**
 * The Google event id for (booking, host): "ls" + 40 hex chars of sha256.
 * Every character is base32hex (a–v, 0–9) and the length (42) is inside
 * Google's 5–1024, so Google accepts it as a client-supplied id.
 */
export function googleEventIdFor(eventId: string, uid: string): string {
  return `ls${crypto.createHash("sha256").update(`${eventId}:${uid}`).digest("hex").slice(0, 40)}`;
}

function toDate(v: unknown): Date | null {
  const d = (v as { toDate?: () => Date } | null)?.toDate?.() ?? v;
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

const isNotFound = (err: unknown) => err instanceof GbpProviderError && err.kind === "not_found";

/** What a push converged to — compared after the Google calls. */
function fingerprint(e: SyncedEvent): string {
  return JSON.stringify([
    eventStatus(e),
    toDate(e.startAt)?.getTime() ?? null,
    toDate(e.endAt)?.getTime() ?? null,
    [...eventHostUids(e)].sort(),
  ]);
}

async function loadPage(e: SyncedEvent): Promise<BookingPage | null> {
  if (!e.bookingPageSlug) return null;
  const snap = await getAdminDb().doc(`subAccounts/${e.subAccountId}/bookingPages/${e.bookingPageSlug}`).get();
  return snap.exists ? (snap.data() as BookingPage) : null;
}

async function eligibleHosts(
  e: SyncedEvent,
  page: BookingPage | null,
): Promise<{ eligible: string[]; skipped: string[] }> {
  const allowed = new Set([...(page?.hosts ?? []).map((h) => h.uid), ...(e.hostUids ?? [])]);
  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const uid of eventHostUids(e)) {
    if (allowed.has(uid) && (await isActiveMember(e.subAccountId, uid))) eligible.push(uid);
    else skipped.push(uid);
  }
  return { eligible, skipped };
}

function input(eventId: string, e: SyncedEvent, start: Date, end: Date): GcalEventInput {
  return {
    status: "confirmed",
    summary: e.title || "Booking",
    description: e.notes || "",
    location: e.meetingUrl || e.location || "",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { leadstackEventId: eventId } },
  };
}

/**
 * One pass. Returns the fingerprint it converged to, or null when it did
 * nothing. `removeAll`: take every Google copy down (the event is about to be
 * deleted outright).
 */
async function convergeOnce(eventId: string, removeAll = false): Promise<string | null> {
  const ref = getAdminDb().collection("events").doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const e = snap.data() as SyncedEvent;
  const sa = e.subAccountId;
  const prior = { ...(e.googleEventIds ?? {}) };
  const start = toDate(e.startAt);
  const end = toDate(e.endAt);
  const status = eventStatus(e);
  const live = !removeAll && eventOccupiesSlot(status);
  if (!live && !removeAll && status !== "cancelled") return null;
  if (live && (!start || !end)) return null;

  const page = live ? await loadPage(e) : null;
  const { eligible, skipped } = live ? await eligibleHosts(e, page) : { eligible: [], skipped: [] };
  if (eligible.length === 0 && skipped.length === 0 && Object.keys(prior).length === 0) return null;
  // Writing needs the gate. Removing what we already wrote does not, so a gate
  // switched off never strands a cancelled booking in someone's calendar.
  if (live && !(await googleCalendarGateOn(sa))) return null;

  const hostName = (uid: string) =>
    page?.hosts?.find((h) => h.uid === uid)?.name ??
    (e.assignedToUid === uid ? e.assignedToName : null) ??
    "a host";
  const failures: string[] = skipped.map(
    (uid) => `Not in ${hostName(uid)}'s Google Calendar: not an active host of this booking page.`,
  );
  const ids: Record<string, string> = { ...prior };

  const upsert = async (uid: string) => {
    try {
      const conn = await readConnection(sa, uid);
      if (!conn || conn.status !== "connected") return;
      const gid = prior[uid] ?? googleEventIdFor(eventId, uid);
      await withBudget(GOOGLE_PUSH_TIMEOUT_MS, async (signal) => {
        const provider = await getGcalProviderFor(sa, uid);
        await withGoogleToken(conn, provider, (t) => provider.putEvent(t, gid, input(eventId, e, start!, end!), signal), signal);
      });
      ids[uid] = gid;
      if (conn.lastPushError) {
        await getAdminDb().doc(gcalConnectionPath(sa, uid)).update({ lastPushError: null, lastPushErrorAt: null });
      }
    } catch (err) {
      failures.push(`Not in ${hostName(uid)}'s Google Calendar: ${describeFailure(err)}`);
      await recordConnectionError(sa, uid, err, "push");
    }
  };

  const remove = async (uid: string) => {
    try {
      const conn = await readConnection(sa, uid);
      // A host who disconnected (or was revoked) has nothing we can remove.
      if (!conn || conn.status !== "connected") {
        delete ids[uid];
        return;
      }
      await withBudget(GOOGLE_PUSH_TIMEOUT_MS, async (signal) => {
        const provider = await getGcalProviderFor(sa, uid);
        await withGoogleToken(conn, provider, async (t) => {
          try {
            await provider.deleteEvent(t, prior[uid], signal);
          } catch (err) {
            if (!isNotFound(err)) throw err;
          }
        }, signal);
      });
      delete ids[uid];
    } catch (err) {
      failures.push(`Still in ${hostName(uid)}'s Google Calendar: ${describeFailure(err)}`);
      await recordConnectionError(sa, uid, err, "push");
    }
  };

  await Promise.all([
    ...eligible.map(upsert),
    ...Object.keys(prior).filter((uid) => !eligible.includes(uid)).map(remove),
  ]);

  await ref.update({
    googleEventIds: ids,
    googleSyncError: failures.length > 0 ? { message: failures.join(" "), at: new Date() } : null,
  });
  return fingerprint(e);
}

async function sync(eventId: string): Promise<void> {
  const converged = await convergeOnce(eventId);
  if (converged === null) return;
  // A reschedule / cancel / reassign that landed while we were talking to
  // Google: converge once more to what is stored now.
  const now = await getAdminDb().collection("events").doc(eventId).get();
  if (now.exists && fingerprint(now.data() as SyncedEvent) !== converged) {
    await convergeOnce(eventId);
  }
}

/**
 * Before a server path deletes an event outright: remove its Google copies.
 * Never throws.
 */
export async function removeBookingFromGoogle(eventId: string): Promise<void> {
  try {
    await convergeOnce(eventId, true);
  } catch (err) {
    const kind = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.error(`[google-calendar] remove failed event=${eventId}`, kind);
  }
}

/**
 * For a caller whose response must not wait on Google (the public book route,
 * the voice agent's tool reply): run the push after the response via Next's
 * `after()`. Outside a request scope (unit tests, scripts) `after` throws —
 * the push then runs detached, its failures logged by pushBookingToGoogle.
 */
export function pushBookingToGoogleAfterResponse(eventId: string): void {
  try {
    after(() => pushBookingToGoogle(eventId));
  } catch {
    void pushBookingToGoogle(eventId);
  }
}

/** Converge Google to `events/{eventId}`. Never throws. */
export async function pushBookingToGoogle(eventId: string): Promise<void> {
  try {
    await sync(eventId);
  } catch (err) {
    const kind = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.error(`[google-calendar] push failed event=${eventId}`, kind);
  }
}

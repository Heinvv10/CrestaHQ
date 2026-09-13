import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { eventOccupiesSlot, eventStatus, type CalendarEvent } from "@/types/events";
import { describeFailure, readConnection, recordConnectionError, withGoogleToken } from "./connection";
import { googleCalendarGateOn } from "./gate";
import { getGcalProviderFor } from "./provider/select";
import type { GcalEventInput } from "./provider/types";

/**
 * Mirror one booking into its hosts' primary Google calendars (G3).
 *
 * Reads the event AFTER the caller's commit and converges Google to it: an
 * occupying event (scheduled / awaiting payment) is inserted or patched for
 * every host; a cancelled one — and any host no longer on the event — has its
 * Google copy deleted. Completed / no-show events are left alone. Because the
 * action comes from the stored status, a push that races another (a cancel
 * right after a reschedule) still ends where Firestore ends.
 *
 * Best-effort: never throws into the booking route. A failure is recorded on
 * the event (`googleSyncError`) and on that host's connection.
 */

/** Server-only fields on `events/{id}` (firestore.rules locks them from clients). */
export interface GoogleSyncFields {
  /** Host uid → the Google event id written to that host's primary calendar. */
  googleEventIds?: Record<string, string> | null;
  googleSyncError?: { message: string; at: Date } | null;
}

type SyncedEvent = CalendarEvent & GoogleSyncFields;

/** The event's hosts: `hostUids` (collective pages, PR #109) or the assigned host. */
function eventHostUids(event: SyncedEvent): string[] {
  const collective = (event as { hostUids?: unknown }).hostUids;
  if (Array.isArray(collective) && collective.length > 0) {
    return [...new Set(collective.filter((u): u is string => typeof u === "string" && !!u))];
  }
  return event.assignedToUid ? [event.assignedToUid] : [];
}

function toDate(v: unknown): Date | null {
  const d = (v as { toDate?: () => Date } | null)?.toDate?.() ?? v;
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

function googleInput(eventId: string, event: SyncedEvent, start: Date, end: Date): GcalEventInput {
  return {
    summary: event.title || "Booking",
    description: event.notes || "",
    location: event.meetingUrl || event.location || "",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { leadstackEventId: eventId } },
  };
}

const isNotFound = (err: unknown) => err instanceof GbpProviderError && err.kind === "not_found";

async function sync(eventId: string): Promise<void> {
  const ref = getAdminDb().collection("events").doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const event = snap.data() as SyncedEvent;
  const sa = event.subAccountId;
  const prior = { ...(event.googleEventIds ?? {}) };
  const start = toDate(event.startAt);
  const end = toDate(event.endAt);
  const status = eventStatus(event);
  const live = eventOccupiesSlot(status);
  // A meeting that happened (completed / no-show) keeps its Google copy; only
  // a cancellation removes it.
  if (!live && status !== "cancelled") return;
  if (live && (!start || !end)) return;

  const hosts = live ? eventHostUids(event) : [];
  if (hosts.length === 0 && Object.keys(prior).length === 0) return;
  // Writing needs the gate. Removing what we already wrote does not, so a gate
  // switched off never strands a cancelled booking in someone's calendar.
  if (live && !(await googleCalendarGateOn(sa))) return;

  const ids = { ...prior };
  const errors: string[] = [];

  for (const uid of hosts) {
    const conn = await readConnection(sa, uid);
    if (!conn || conn.status !== "connected") continue;
    try {
      const provider = await getGcalProviderFor(sa, uid);
      const input = googleInput(eventId, event, start!, end!);
      ids[uid] = await withGoogleToken(conn, provider, async (token) => {
        if (ids[uid]) {
          try {
            await provider.patchEvent(token, ids[uid], input);
            return ids[uid];
          } catch (err) {
            // The member deleted our copy in Google: write a fresh one.
            if (!isNotFound(err)) throw err;
          }
        }
        return provider.insertEvent(token, input);
      });
    } catch (err) {
      errors.push(describeFailure(err));
      await recordConnectionError(sa, uid, err);
    }
  }

  for (const uid of Object.keys(prior)) {
    if (hosts.includes(uid)) continue;
    const conn = await readConnection(sa, uid);
    // A host who disconnected (or was revoked) has nothing we can remove.
    if (!conn || conn.status !== "connected") {
      delete ids[uid];
      continue;
    }
    try {
      const provider = await getGcalProviderFor(sa, uid);
      await withGoogleToken(conn, provider, async (token) => {
        try {
          await provider.deleteEvent(token, prior[uid]);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      });
      delete ids[uid];
    } catch (err) {
      errors.push(describeFailure(err));
      await recordConnectionError(sa, uid, err);
    }
  }

  await ref.update({
    googleEventIds: ids,
    googleSyncError: errors.length > 0 ? { message: errors.join(" "), at: new Date() } : null,
  });
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

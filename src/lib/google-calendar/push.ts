import "server-only";

import crypto from "node:crypto";
import { after } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { queryHostEvents } from "@/lib/booking/hosts";
import { eventHostUids } from "@/lib/booking/page-slots";
import { effectiveBookingLocation } from "@/lib/booking/location";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import type { BookingPage } from "@/types/booking";
import { eventOccupiesSlot, eventStatus, isImportedEvent, type CalendarEvent } from "@/types/events";
import {
  activeGoogleHosts,
  isActiveMember,
  describeFailure,
  gcalConnectionPath,
  readConnection,
  recordConnectionError,
  withBudget,
  withGoogleToken,
} from "./connection";
import { googleCalendarGateOn } from "./gate";
import { getGcalProviderFor } from "./provider/select";
import { meetUrlOf, type GcalEventInput } from "./provider/types";
import { runAfterResponse } from "@/lib/server/after-response";
import { sendMeetLinkFollowUp } from "@/lib/booking/meet-link-follow-up";

/**
 * Mirror one booking into its hosts' primary Google calendars (G3).
 *
 * Reads the event AFTER the caller's commit and converges Google to it: an
 * occupying event (scheduled / awaiting payment) is written for every
 * eligible host; a cancelled one — and any host no longer on the event — has
 * its Google copy deleted. Completed / no-show events are left alone.
 *
 * Eligible hosts: the event's own hosts (`assignedToUid` ∪ `hostUids`, both
 * server-set — the rules lock them from clients) that are ACTIVE members —
 * the same rule busy loading uses (`activeGoogleHosts`). A host who left the
 * sub-account is skipped and the skip is recorded on the event.
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
  /**
   * The host whose Google copy owns the booking's Meet room. After a
   * reassign that copy is KEPT (marked, shown as free) rather than deleted,
   * until the booking is cancelled or deleted: whether a Meet link survives
   * its calendar event being deleted is not yet proven on a live walk.
   */
  googleMeetOwnerUid?: string | null;
  /** Set while the owner's copy is kept (marked, free time) after a reassign. */
  googleMeetKeptUid?: string | null;
}

/**
 * A copy kept only because it owns the Meet room carries no booker details:
 * this summary, this description, no location — just the time and, left
 * untouched by the PATCH, the conference.
 */
export const KEPT_FOR_MEET_SUMMARY = "Reserved for a Google Meet link";
const KEPT_FOR_MEET_DESCRIPTION =
  "This time holds the Google Meet room of a booking that moved to another host. It is removed when the booking is cancelled, deleted or over.";

/**
 * How a push may store a room's link. `detached`: the booker-facing caller
 * gave up waiting (pushBookingAndGetMeetUrlWithin's deadline) and has
 * already emailed its answer — set while the push runs, read at store time.
 */
interface PushMode {
  detached: boolean;
}

type SyncedEvent = CalendarEvent & GoogleSyncFields;

/** Per-host budget for the whole Google leg, token refresh included. */
export const GOOGLE_PUSH_TIMEOUT_MS = 5_000;
/** Member removal: this many deletes at once, and no longer than this in all. */
const MEMBER_CLEANUP_CONCURRENCY = 5;
export const MEMBER_CLEANUP_TOTAL_MS = 20_000;

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

function hostLabel(e: SyncedEvent, page: BookingPage | null, uid: string): string {
  return (
    page?.hosts?.find((h) => h.uid === uid)?.name ??
    (e.assignedToUid === uid ? e.assignedToName : null) ??
    "a host"
  );
}

async function loadPage(e: SyncedEvent): Promise<BookingPage | null> {
  if (!e.bookingPageSlug) return null;
  const snap = await getAdminDb().doc(`subAccounts/${e.subAccountId}/bookingPages/${e.bookingPageSlug}`).get();
  return snap.exists ? (snap.data() as BookingPage) : null;
}

async function eligibleHosts(e: SyncedEvent): Promise<{ eligible: string[]; skipped: string[] }> {
  const candidates = eventHostUids(e);
  const eligible = await activeGoogleHosts(e.subAccountId, candidates);
  return { eligible, skipped: candidates.filter((uid) => !eligible.includes(uid)) };
}

/** An early return must not leave a stale failure showing on the event. */
async function clearSyncError(ref: FirebaseFirestore.DocumentReference, e: SyncedEvent): Promise<null> {
  if (e.googleSyncError) await ref.update({ googleSyncError: null });
  return null;
}

function input(eventId: string, e: SyncedEvent, start: Date, end: Date, meetUrl: string | null): GcalEventInput {
  return {
    status: "confirmed",
    summary: e.title || "Booking",
    description: e.notes || "",
    location: meetUrl || e.meetingUrl || e.location || "",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { leadstackEventId: eventId } },
  };
}

const isMeetPage = (page: BookingPage | null) =>
  !!page && effectiveBookingLocation(page)?.type === "google_meet";

/**
 * The booking already has its own Meet room: an owner is recorded, or the
 * event holds a Meet link that is not just the page's fallback (a page may
 * use a fixed meet.google.com URL as its fallback — that is not a room).
 */
function hasOwnRoom(e: SyncedEvent, page: BookingPage | null): boolean {
  if (typeof e.googleMeetOwnerUid === "string" && e.googleMeetOwnerUid) return true;
  return !!meetUrlOf(e.meetingUrl) && e.meetingUrl !== (page?.meetingUrl ?? null);
}

/**
 * Google Meet pages: the host whose Google copy carries the Meet room — the
 * assigned host (a collective meeting's first host), when eligible. Every
 * other host's copy carries the link as its location. Decided from the page
 * (reached through the server-set `bookingPageSlug`), so a client-written
 * event can't ask for a room. A booking that already has its own room never
 * asks for another (a reassign or reschedule keeps the booker's link).
 */
function meetHostFor(e: SyncedEvent, page: BookingPage | null, eligible: string[]): string | null {
  if (!isMeetPage(page) || hasOwnRoom(e, page)) return null;
  return e.assignedToUid && eligible.includes(e.assignedToUid) ? e.assignedToUid : null;
}

/** The event's link may be replaced by a room's only while it is empty or the page's fallback. */
const replaceable = (current: string | null | undefined, fallback: string | null) =>
  !current || current === fallback;

/**
 * May a room's link go onto the event over `current`? Empty, or the page's
 * fallback — except once detached: the booker was already sent the fallback
 * (or told the link will follow), so only an empty link is filled.
 */
const mayStore = (current: string | null | undefined, fallback: string | null, mode: PushMode) =>
  mode.detached ? !current : replaceable(current, fallback);

type Converged = { fingerprint: string; meetUrl: string | null; stored: boolean };

/**
 * Store a Meet room's link on the event, in a transaction that re-reads it:
 * only while `mayStore` holds. Anything else is an operator's own link (or
 * the fallback a booker was already sent) and wins. True when stored.
 */
async function storeMeetUrl(
  ref: FirebaseFirestore.DocumentReference,
  fallback: string | null,
  meetUrl: string,
  ownerUid: string,
  mode: PushMode,
): Promise<boolean> {
  const stored = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    if (!mayStore((snap.data() as SyncedEvent).meetingUrl, fallback, mode)) return false;
    tx.update(ref, { meetingUrl: meetUrl, googleMeetOwnerUid: ownerUid });
    return true;
  });
  if (!stored) console.warn(`[google-calendar] Meet room kept off event=${ref.id}: it holds its own meeting link`);
  return stored;
}

/**
 * One pass. Returns the fingerprint it converged to (and the event's Meet
 * link, when this pass saw one), or null when it did nothing. `removeAll`:
 * take every Google copy down (the event is about to be deleted outright).
 */
async function convergeOnce(
  eventId: string,
  removeAll = false,
  mode: PushMode = { detached: false },
): Promise<Converged | null> {
  const ref = getAdminDb().collection("events").doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const e = snap.data() as SyncedEvent;
  // An imported event came FROM Google: writing it back would duplicate it.
  if (isImportedEvent(e)) return null;
  const sa = e.subAccountId;
  const prior = { ...(e.googleEventIds ?? {}) };
  const start = toDate(e.startAt);
  const end = toDate(e.endAt);
  const status = eventStatus(e);
  const live = !removeAll && eventOccupiesSlot(status);
  // Completed / no-show: the meeting happened, its Google copy stays — all
  // but a copy kept only for the Meet room, which goes now.
  if (!live && !removeAll && status !== "cancelled") {
    if (e.googleMeetOwnerUid) return releaseRoomOwner(ref, e);
    return clearSyncError(ref, e);
  }
  if (live && (!start || !end)) return null;

  const page = live ? await loadPage(e) : null;
  const { eligible, skipped } = live ? await eligibleHosts(e) : { eligible: [], skipped: [] };
  if (eligible.length === 0 && skipped.length === 0 && Object.keys(prior).length === 0) {
    return clearSyncError(ref, e);
  }
  // Writing needs the gate. Removing what we already wrote does not, so a gate
  // switched off never strands a cancelled booking in someone's calendar.
  if (live && !(await googleCalendarGateOn(sa))) return clearSyncError(ref, e);

  const hostName = (uid: string) => hostLabel(e, page, uid);
  const failures: string[] = skipped.map(
    (uid) => `Not in ${hostName(uid)}'s Google Calendar: no longer an active member of this sub-account.`,
  );
  const ids: Record<string, string> = { ...prior };
  const meetHost = live ? meetHostFor(e, page, eligible) : null;
  let meetUrl: string | null = null;
  // Reassigned away from the host whose copy owns the Meet room: keep that
  // copy (marked, free time) while the booking is live and that host is
  // still an active member (checked per host, below). A cancel or delete
  // removes it like any other.
  const owner = typeof e.googleMeetOwnerUid === "string" ? e.googleMeetOwnerUid : null;
  const keepCandidate =
    live && owner && prior[owner] && !eligible.includes(owner) && hasOwnRoom(e, page) ? owner : null;
  const wasKept = typeof e.googleMeetKeptUid === "string" ? e.googleMeetKeptUid : null;
  let keptNow = wasKept;

  const upsert = async (uid: string, kept = false) => {
    try {
      const conn = await readConnection(sa, uid);
      if (!conn || conn.status !== "connected") return;
      const gid = prior[uid] ?? googleEventIdFor(eventId, uid);
      const body = input(eventId, e, start!, end!, meetUrl);
      if (kept) {
        // No booker details in a former host's calendar.
        body.summary = KEPT_FOR_MEET_SUMMARY;
        body.description = KEPT_FOR_MEET_DESCRIPTION;
        body.location = "";
        body.transparency = "transparent";
      } else if (uid === wasKept) {
        // Leaving kept state: busy again (a PATCH would keep "transparent").
        body.transparency = "opaque";
      }
      // The room is asked for once, when the Meet host's copy is first made.
      if (uid === meetHost && !prior[uid]) {
        body.conferenceData = { createRequest: { requestId: `meet-${gid}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
      }
      const put = await withBudget(GOOGLE_PUSH_TIMEOUT_MS, async (signal) => {
        const provider = await getGcalProviderFor(sa, uid);
        return withGoogleToken(conn, provider, (t) => provider.putEvent(t, gid, body, signal), signal);
      });
      if (uid === meetHost) meetUrl = put.meetUrl;
      if (kept) keptNow = uid;
      else if (uid === keptNow) keptNow = null;
      ids[uid] = gid;
      if (conn.lastPushError) {
        await getAdminDb().doc(gcalConnectionPath(sa, uid)).update({ lastPushError: null, lastPushErrorAt: null });
      }
    } catch (err) {
      failures.push(`Not in ${hostName(uid)}'s Google Calendar: ${describeFailure(err, "push")}`);
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
      if (uid === keptNow) keptNow = null;
    } catch (err) {
      failures.push(`Still in ${hostName(uid)}'s Google Calendar: ${describeFailure(err, "push")}`);
      await recordConnectionError(sa, uid, err, "remove");
    }
  };

  /** The room owner's copy: kept while they are an active member, else removed. */
  const keepOrRemove = async (uid: string) => {
    let active: boolean;
    try {
      active = await isActiveMember(sa, uid);
    } catch (err) {
      // Unknown: leave the copy as it is rather than delete the room's event.
      console.warn(`[google-calendar] membership check failed event=${eventId}`, err instanceof Error ? err.message : String(err));
      failures.push(`Kept in ${hostName(uid)}'s Google Calendar for now: couldn't check whether they are still a member.`);
      return;
    }
    await (active ? upsert(uid, true) : remove(uid));
  };

  // The Meet host first: the other hosts' copies carry its link.
  if (meetHost) await upsert(meetHost);
  await Promise.all([
    ...eligible.filter((uid) => uid !== meetHost).map((uid) => upsert(uid)),
    ...(keepCandidate ? [keepOrRemove(keepCandidate)] : []),
    ...Object.keys(prior).filter((uid) => !eligible.includes(uid) && uid !== keepCandidate).map(remove),
  ]);

  await ref.update({
    googleEventIds: ids,
    googleSyncError: failures.length > 0 ? { message: failures.join(" "), at: new Date() } : null,
    ...(keptNow !== wasKept ? { googleMeetKeptUid: keptNow } : {}),
  });
  // The room's link (just made, or found on an overwrite after a first push
  // timed out once Google had made it) replaces the event's link only while
  // that is empty or the page's fallback. An operator's own link wins.
  const room: string | null = meetUrl;
  const fallback = page?.meetingUrl ?? null;
  const stored =
    !!room && room !== e.meetingUrl && mayStore(e.meetingUrl, fallback, mode)
      ? await storeMeetUrl(ref, fallback, room, meetHost!, mode)
      : false;
  if (room && !stored && room !== e.meetingUrl && !mayStore(e.meetingUrl, fallback, mode)) {
    console.warn(`[google-calendar] Meet room kept off event=${eventId}: it holds its own meeting link`);
  }
  const held = isMeetPage(page) && hasOwnRoom(e, page) ? meetUrlOf(e.meetingUrl) : null;
  return { fingerprint: fingerprint(e), meetUrl: stored ? room : held, stored };
}

/**
 * A completed / no-show booking: take down the copy kept only because it
 * owns the Meet room (the owner is no longer on the booking) and clear the
 * owner. The owner's own copy, when they are still on it, stays like every
 * host's. A copy that can't be removed is recorded, its id kept.
 */
async function releaseRoomOwner(ref: FirebaseFirestore.DocumentReference, e: SyncedEvent): Promise<null> {
  const owner = e.googleMeetOwnerUid!;
  const gid = e.googleEventIds?.[owner];
  const clear = { googleMeetOwnerUid: null, googleMeetKeptUid: null };
  if (!gid || eventHostUids(e).includes(owner)) {
    await ref.update(clear);
    return null;
  }
  const sa = e.subAccountId;
  try {
    const conn = await readConnection(sa, owner);
    if (!conn || conn.status !== "connected") throw new GbpProviderError("revoked");
    await withBudget(GOOGLE_PUSH_TIMEOUT_MS, async (signal) => {
      const provider = await getGcalProviderFor(sa, owner);
      await withGoogleToken(conn, provider, async (t) => {
        try {
          await provider.deleteEvent(t, gid, signal);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }, signal);
    });
    await ref.update({ ...clear, [`googleEventIds.${owner}`]: FieldValue.delete() });
  } catch (err) {
    const name = hostLabel(e, await loadPage(e).catch(() => null), owner);
    await ref.update({
      googleSyncError: { message: `Still in ${name}'s Google Calendar: ${describeFailure(err, "push")}`, at: new Date() },
    });
  }
  return null;
}

async function sync(eventId: string, mode?: PushMode): Promise<{ meetUrl: string | null; stored: boolean }> {
  const converged = await convergeOnce(eventId, false, mode);
  if (converged === null) return { meetUrl: null, stored: false };
  // A reschedule / cancel / reassign that landed while we were talking to
  // Google: converge once more to what is stored now.
  const now = await getAdminDb().collection("events").doc(eventId).get();
  if (now.exists && fingerprint(now.data() as SyncedEvent) !== converged.fingerprint) {
    const again = await convergeOnce(eventId, false, mode);
    return {
      meetUrl: converged.meetUrl ?? again?.meetUrl ?? null,
      stored: converged.stored || !!again?.stored,
    };
  }
  return { meetUrl: converged.meetUrl, stored: converged.stored };
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

/**
 * For a route about to delete an event outright: take its Google copies down,
 * then say whether any is LEFT. The caller must refuse the delete when one is
 * — deleting would orphan a copy (customer name, notes) nothing could reach
 * again, while telling the operator it was deleted.
 */
export async function removeBookingFromGoogleBeforeDelete(
  eventId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await removeBookingFromGoogle(eventId);
  const ref = getAdminDb().collection("events").doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: true };
  const e = snap.data() as SyncedEvent;
  const left = Object.keys(e.googleEventIds ?? {});
  if (left.length === 0) return { ok: true };
  const page = await loadPage(e).catch(() => null);
  const names = left.map((uid) => hostLabel(e, page, uid)).join(" and ");
  const message = `Couldn't remove it from ${names}'s Google Calendar — try again.`;
  if (!e.googleSyncError) await ref.update({ googleSyncError: { message, at: new Date() } });
  return { ok: false, message };
}

/**
 * Member removal, BEFORE their tokens are deleted: take their Google copies
 * of upcoming bookings down (nothing could reach them afterwards). The next
 * push for each booking then records them as no longer a member. Never throws.
 *
 * Also every copy KEPT in their calendar for a Google Meet room after a
 * reassign (`googleMeetOwnerUid`, any date): they are no longer on those
 * bookings, so the host query can't find them. Those go first, and each
 * event's owner is cleared. Without a working connection nothing can be
 * removed: each such event records it in `googleSyncError`, id kept.
 */
export async function removeMemberGoogleCopies(subAccountId: string, uid: string): Promise<void> {
  try {
    const conn = await readConnection(subAccountId, uid);
    const owned = (
      await getAdminDb()
        .collection("events")
        .where("subAccountId", "==", subAccountId)
        .where("googleMeetOwnerUid", "==", uid)
        .get()
    ).docs.filter((d) => !isImportedEvent(d.data() as SyncedEvent));
    const hasCopy = (d: FirebaseFirestore.QueryDocumentSnapshot) => !!(d.data() as SyncedEvent).googleEventIds?.[uid];
    const nameIn = async (d: FirebaseFirestore.QueryDocumentSnapshot) => {
      const e = d.data() as SyncedEvent;
      return hostLabel(e, await loadPage(e).catch(() => null), uid);
    };

    if (!conn || conn.status !== "connected") {
      await Promise.all(
        owned.map(async (d) =>
          d.ref
            .update({
              googleMeetOwnerUid: null,
              ...(hasCopy(d)
                ? {
                    googleSyncError: {
                      message: `Still in ${await nameIn(d)}'s Google Calendar: they left with their Google Calendar not connected, so the copy kept for the Google Meet link couldn't be removed.`,
                      at: new Date(),
                    },
                  }
                : {}),
            })
            .catch((err) => console.warn(`[google-calendar] removed-member owner clear failed event=${d.id}`, err instanceof Error ? err.message : String(err))),
        ),
      );
      return;
    }

    // Owners without a copy left: just clear the owner.
    await Promise.all(owned.filter((d) => !hasCopy(d)).map((d) => d.ref.update({ googleMeetOwnerUid: null })));
    const docs = await queryHostEvents(subAccountId, uid, (q) => q.where("startAt", ">=", new Date()));
    const queue = [...new Map([...owned.filter(hasCopy), ...docs.filter(hasCopy)].map((d) => [d.id, d])).values()];
    const provider = await getGcalProviderFor(subAccountId, uid);
    const deadline = Date.now() + MEMBER_CLEANUP_TOTAL_MS;
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const gid = (d.data() as SyncedEvent).googleEventIds![uid];
        try {
          await withBudget(Math.min(GOOGLE_PUSH_TIMEOUT_MS, Math.max(0, deadline - Date.now())), (signal) =>
            withGoogleToken(conn, provider, async (t) => {
              try {
                await provider.deleteEvent(t, gid, signal);
              } catch (err) {
                if (!isNotFound(err)) throw err;
              }
            }, signal),
          );
          await d.ref.update({
            [`googleEventIds.${uid}`]: FieldValue.delete(),
            ...((d.data() as SyncedEvent).googleMeetOwnerUid === uid ? { googleMeetOwnerUid: null } : {}),
            ...((d.data() as SyncedEvent).googleMeetKeptUid === uid ? { googleMeetKeptUid: null } : {}),
          });
        } catch (err) {
          const name = await nameIn(d);
          await d.ref
            .update({ googleSyncError: { message: `Still in ${name}'s Google Calendar: ${describeFailure(err, "push")}`, at: new Date() } })
            .catch(() => undefined);
        }
        if (Date.now() >= deadline) break;
      }
    };
    await Promise.all(Array.from({ length: MEMBER_CLEANUP_CONCURRENCY }, worker));
    if (queue.length > 0) {
      console.warn(`[google-calendar] removed-member cleanup ran out of time sa=${subAccountId} left=${queue.length}`);
    }
  } catch (err) {
    console.error(`[google-calendar] removed-member cleanup failed sa=${subAccountId}`, err instanceof Error ? err.name : typeof err);
  }
}

/** Converge Google to `events/{eventId}`. Never throws. */
export async function pushBookingToGoogle(eventId: string): Promise<void> {
  await pushBookingAndGetMeetUrl(eventId);
}

/**
 * The same push, for a caller that needs the booking's Google Meet link
 * (the book route, before the confirmation email). `meetUrl` is the link now
 * stored on the event, or null when no room was made (not a Meet page, the
 * host isn't connected, Google failed). Never throws.
 */
export async function pushBookingAndGetMeetUrl(eventId: string): Promise<{ meetUrl: string | null }> {
  const { meetUrl } = await pushWithMode(eventId, { detached: false });
  return { meetUrl };
}

async function pushWithMode(eventId: string, mode: PushMode): Promise<{ meetUrl: string | null; stored: boolean }> {
  try {
    return await sync(eventId, mode);
  } catch (err) {
    const kind = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.error(`[google-calendar] push failed event=${eventId}`, kind);
    return { meetUrl: null, stored: false };
  }
}

/** The longest a booker-facing path waits on Google for a Meet link. */
export const MEET_PUSH_DEADLINE_MS = 6_000;

/**
 * pushBookingAndGetMeetUrl for a path that sends the booker's email next
 * (the book route, mark-paid): one overall deadline. Past it the answer is
 * `{ meetUrl: null }` (the caller says the link will follow) and the push
 * carries on detached — registered with after() when it starts, so a
 * serverless host keeps it alive. Detached, it only FILLS an empty link
 * (never replaces the fallback the booker was just sent), and when it does,
 * the booker gets one follow-up email with the link. Never throws.
 */
export async function pushBookingAndGetMeetUrlWithin(
  eventId: string,
  ms: number = MEET_PUSH_DEADLINE_MS,
): Promise<{ meetUrl: string | null; pending: boolean }> {
  const mode: PushMode = { detached: false };
  const push = pushWithMode(eventId, mode);
  runAfterResponse(async () => {
    const r = await push;
    if (mode.detached && r.stored && r.meetUrl) await sendMeetLinkFollowUp(eventId, r.meetUrl);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // `pending`: the deadline passed with the push still running — a room may
  // yet land on the event, unlike a push that finished without one.
  const deadline = new Promise<{ meetUrl: null; pending: true }>((resolve) => {
    timer = setTimeout(() => {
      mode.detached = true;
      console.warn(`[google-calendar] Meet push past ${ms}ms event=${eventId}; continuing detached`);
      resolve({ meetUrl: null, pending: true });
    }, ms);
  });
  try {
    return await Promise.race([push.then((r) => ({ meetUrl: r.meetUrl, pending: false })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

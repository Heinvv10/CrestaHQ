import "server-only";

import { canTakePayment, NO_PAYMENT_RAIL_MESSAGE } from "@/lib/payments/can-take-payment";
import { getAdminDb } from "@/lib/firebase/admin";
import { validateBookingPageFormData, validateCalendarTypeHosts } from "@/lib/booking/validation";
import { resolveBookingHosts } from "@/lib/booking/hosts";
import { readConnection } from "@/lib/google-calendar/connection";
import { googleCalendarGateOn } from "@/lib/google-calendar/gate";
import { effectiveBookingLocation } from "@/lib/booking/location";
import type { BookingHost, BookingLocation, BookingPage, BookingPageFormData, CalendarType } from "@/types/booking";

/**
 * Booking-page writes shared by the booking-page routes and the agent's
 * booking-page capabilities: a create or full-replace edit checked exactly
 * as the routes check it, and the upcoming-bookings count that blocks a
 * delete.
 */

export type PageWriteFailure = { ok: false; status: number; error: string };

/** What an edit needs of the stored page to judge a Google Meet change. */
export type StoredMeetFields = Pick<BookingPage, "location" | "googleMeet" | "meetingUrl" | "status">;

/**
 * Validate a create (no `edit`) or full-replace edit body (`edit`, with the
 * page's stored calendar type and Meet fields): the form
 * validator, the sub-account (create), the payment rail when a deposit is
 * asked, the hosts re-resolved against live membership, and Google Meet's
 * setup. Meet's setup is REFUSED only when Meet is being switched on (a
 * create, a page becoming Meet, or a Meet page going live); any other save
 * of a Meet page whose setup broke later — a host disconnected — goes
 * through with `warning`, so it can still be edited or unpublished.
 */
export async function prepareBookingPage(
  subAccountId: string,
  body: unknown,
  edit?: { storedType: CalendarType | undefined; stored?: StoredMeetFields },
): Promise<
  { ok: true; data: BookingPageFormData; agencyId: string | null; warning?: string } | PageWriteFailure
> {
  const storedType = edit?.storedType;
  const validated = validateBookingPageFormData(body, storedType);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const data = validated.value;
  const create = edit === undefined;

  // An edit reads the sub-account only for the payment gate, as the route did.
  const subSnap = create || data.payment ? await getAdminDb().doc(`subAccounts/${subAccountId}`).get() : null;
  if (create && !subSnap?.exists) return { ok: false, status: 404, error: "Sub-account not found" };
  const sub = subSnap?.data() ?? {};
  const agencyId = (sub.agencyId as string | undefined) ?? null;
  if (create && !agencyId) return { ok: false, status: 500, error: "Sub-account is missing tenancy metadata." };

  // A deposit needs a payment rail - the public page would render a Pay
  // button that goes nowhere.
  if (data.payment && !canTakePayment(sub)) {
    return { ok: false, status: 400, error: `${NO_PAYMENT_RAIL_MESSAGE} A booking page can't require a deposit until then.` };
  }

  // Keep only active members + re-snapshot their display names (don't trust client names).
  const hosts = await resolveBookingHosts(subAccountId, data.hosts);
  // A body without a type keeps the stored one - check hosts against that.
  const hostsOk = validateCalendarTypeHosts(data.calendarType ?? storedType, hosts.length);
  if (!hostsOk.ok) return { ok: false, status: 400, error: hostsOk.error };
  const meet = await meetSetupError(subAccountId, data.location, hosts);
  if (meet && meetSwitchingOn(data, edit?.stored)) return { ok: false, status: 400, error: meet };
  return { ok: true, data: { ...data, hosts }, agencyId, ...(meet ? { warning: `Saved, but ${meet}` } : {}) };
}

/** A create, a page becoming Google Meet, or a Meet page going live. */
function meetSwitchingOn(data: BookingPageFormData, stored: StoredMeetFields | undefined): boolean {
  if (data.location?.type !== "google_meet") return false;
  if (!stored) return true;
  if (effectiveBookingLocation(stored)?.type !== "google_meet") return true;
  return stored.status !== "published" && data.status === "published";
}

/**
 * Google Meet links are made on a host's own Google Calendar by the booking
 * push, so the page may only offer Meet while Calendar sync is on for the
 * sub-account and every host (live membership, already resolved) has a
 * working connection. Null = fine, or not a Meet page.
 */
export async function meetSetupError(
  subAccountId: string,
  location: BookingLocation | null | undefined,
  hosts: BookingHost[],
): Promise<string | null> {
  if (location?.type !== "google_meet") return null;
  if (!(await googleCalendarGateOn(subAccountId))) {
    return "Google Meet needs Calendar sync, which isn't switched on for this workspace.";
  }
  if (hosts.length === 0) {
    return "Google Meet needs a host on this page with Google Calendar connected. Add a host under Team, or pick another location.";
  }
  const conns = await Promise.all(hosts.map((h) => readConnection(subAccountId, h.uid)));
  const missing = hosts.filter((_, i) => conns[i]?.status !== "connected").map((h) => h.name);
  if (missing.length > 0) {
    return `Google Meet needs every host's Google Calendar connected (Settings → Calendar sync). Not connected: ${missing.join(", ")}.`;
  }
  return null;
}

type QueryGet = (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>;

/**
 * Bookings on this page not yet over (ending now or later, so one in
 * progress counts; an event without an end is judged by its start), and
 * not cancelled.
 * Equality filters only, counted in memory, so the guard works without the
 * events(subAccountId, bookingPageSlug, startAt) composite index.
 */
export async function upcomingBookingCount(subAccountId: string, slug: string, get: QueryGet = (q) => q.get()): Promise<number> {
  const nowMs = Date.now();
  const snap = await get(getAdminDb().collection("events").where("subAccountId", "==", subAccountId).where("bookingPageSlug", "==", slug));
  return snap.docs.filter((doc) => {
    const d = doc.data();
    if (d.status === "cancelled") return false;
    const ms = ((d.endAt ?? d.startAt) as { toMillis?: () => number } | null | undefined)?.toMillis?.();
    return typeof ms === "number" && ms >= nowMs;
  }).length;
}

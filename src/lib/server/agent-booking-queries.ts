import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { pageCalendarType } from "@/lib/booking/calendar-types";
import { groupSlotsByLocalDate, type SlotCandidate } from "@/lib/booking/availability";
import { selectableHostUid } from "@/lib/booking/page-slots";
import { resolvePageAvailability, movingEventOf, departedHostMessage } from "@/lib/booking/resolve-availability";
import { loadGoogleBusyForPage, loadGoogleBusyForEvent } from "@/lib/google-calendar/busy";
import { eventStatus, isImportedEvent, type CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";

export interface AgentBookingContext { page: BookingPage; bookable: boolean; reason: string | null }
export function unbookableReason(page: BookingPage): string | null {
  if (page.status !== "published") return "page_not_published";
  if (page.payment) return "page_requires_payment";
  if (pageCalendarType(page) === "service") return "page_is_service";
  return null;
}
export async function getAgentBookingContext(subAccountId: string, slug: string): Promise<AgentBookingContext | null> {
  if (!isDocId(subAccountId) || !isDocId(slug)) return null;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/bookingPages/${slug}`).get();
  if (!snap.exists) return null;
  const page = snap.data() as BookingPage;
  if (page.subAccountId !== subAccountId || page.slug !== slug) return null;
  const reason = unbookableReason(page);
  return { page, bookable: reason === null, reason };
}
function horizon(page: BookingPage, now: Date): Date {
  return new Date(now.getTime() + Math.min(7, page.visibleDays || 7) * 86400000);
}
function cap(slots: SlotCandidate[], page: BookingPage): SlotCandidate[] {
  return groupSlotsByLocalDate(slots, page.timezone).slice(0, 3).flatMap(day => day.slots.slice(0, 8));
}
export async function listAgentSlots(subAccountId: string, page: BookingPage, hostUid?: string | null): Promise<SlotCandidate[]> {
  const ctx = await getAgentBookingContext(subAccountId, page.slug);
  if (!ctx?.bookable) return [];
  page = ctx.page;
  const now = new Date();
  const toInstant = horizon(page, now);
  return cap(await resolvePageAvailability({
    subAccountId, page, now, toInstant,
    onlyHostUid: selectableHostUid(page, hostUid),
    externalBusy: await loadGoogleBusyForPage({ subAccountId, page, now, toInstant }),
  }), page);
}
/** Read the authoritative booking so a forged assigned host cannot widen the offer. */
export async function listRescheduleSlots(subAccountId: string, page: BookingPage, event: { id: string; assignedToUid?: string | null }): Promise<SlotCandidate[]> {
  if (!isDocId(subAccountId) || !isDocId(event.id) || !isDocId(page.slug)) return [];
  const snap = await getAdminDb().doc(`events/${event.id}`).get();
  if (!snap.exists) return [];
  const stored = { ...snap.data(), id: snap.id } as CalendarEvent;
  if (stored.subAccountId !== subAccountId || stored.bookingPageSlug !== page.slug ||
      stored.source !== "booking_page" || eventStatus(stored) !== "scheduled" || isImportedEvent(stored)) return [];
  const ctx = await getAgentBookingContext(subAccountId, page.slug);
  if (!ctx || await departedHostMessage(ctx.page, stored)) return [];
  page = ctx.page;
  const now = new Date();
  const toInstant = horizon(page, now);
  return cap(await resolvePageAvailability({
    subAccountId, page, now, toInstant, movingEvent: movingEventOf(snap.id, stored),
    externalBusy: await loadGoogleBusyForEvent(snap.id, now, toInstant),
  }), page);
}
/** An upcoming booking-page booking the agent may cancel or move. */
export interface ChangeableBooking {
  eventId: string;
  startAt: Date;
  page: BookingPage;
  assignedToUid: string | null;
  assignedToName: string | null;
}

/**
 * Upcoming, still-scheduled booking-page bookings, either every one of a
 * contact's or only the given event ids. An equality-only query plus in-memory
 * filtering, so no composite index is needed. Pages that no longer exist are
 * skipped (nothing to list times on).
 */
export async function loadChangeableBookings(input: {
  subAccountId: string;
  contactId?: string | null;
  eventIds?: string[];
}): Promise<ChangeableBooking[]> {
  if (!isDocId(input.subAccountId) || (input.contactId != null && !isDocId(input.contactId)) ||
      input.eventIds?.some(id => !isDocId(id))) return [];
  const db = getAdminDb();
  const now = Date.now();
  let docs: FirebaseFirestore.DocumentSnapshot[] = [];
  if (input.eventIds && input.eventIds.length > 0) {
    docs = await db.getAll(
      ...input.eventIds.slice(0, 10).map((id) => db.collection("events").doc(id)),
    );
  } else if (input.contactId) {
    // Equality-only (no composite index). Narrowed to scheduled booking-page
    // events so a contact's other history can't crowd out upcoming bookings.
    const snap = await db
      .collection("events")
      .where("contactId", "==", input.contactId)
      .where("subAccountId", "==", input.subAccountId)
      .where("source", "==", "booking_page")
      .where("status", "==", "scheduled")
      .limit(300)
      .get();
    docs = snap.docs;
  } else {
    return [];
  }

  const candidates: { event: CalendarEvent; startAt: Date }[] = [];
  for (const d of docs) {
    if (!d.exists) continue;
    const e = { ...(d.data() as CalendarEvent), id: d.id };
    if (e.subAccountId !== input.subAccountId) continue;
    if (input.contactId && e.contactId !== input.contactId) continue;
    if (e.source !== "booking_page" || !isDocId(e.bookingPageSlug)) continue;
    if (eventStatus(e) !== "scheduled") continue;
    const startAt = dateOf(e.startAt);
    if (!(startAt instanceof Date) || startAt.getTime() <= now) continue;
    candidates.push({ event: e, startAt });
  }
  candidates.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const pages = new Map<string, BookingPage | null>();
  const out: ChangeableBooking[] = [];
  for (const { event, startAt } of candidates.slice(0, 5)) {
    const slug = event.bookingPageSlug!;
    if (!pages.has(slug)) {
      const snap = await db
        .doc(`subAccounts/${input.subAccountId}/bookingPages/${slug}`)
        .get();
      pages.set(slug, snap.exists ? (snap.data() as BookingPage) : null);
    }
    const page = pages.get(slug);
    if (!page || page.subAccountId !== input.subAccountId || page.slug !== slug) continue;
    out.push({
      eventId: event.id,
      startAt,
      page,
      assignedToUid: event.assignedToUid ?? null,
      assignedToName: event.assignedToName ?? null,
    });
  }
  return out;
}

/**
 * A booking this contact already holds at exactly this start on this page,
 * made in the last few minutes, i.e. the result of an earlier delivery of the
 * same message. Only still-scheduled events count, so a booking that was
 * cancelled since is never replayed as "booked".
 */
export async function findRecentAgentBooking(input: {
  subAccountId: string;
  contactId: string;
  pageSlug: string;
  startAtIso: string;
  withinMs: number;
}): Promise<{ eventId: string; startAt: Date; endAt: Date; assignedToName: string | null } | null> {
  if (!isDocId(input.subAccountId) || !isDocId(input.contactId) || !isDocId(input.pageSlug) ||
      !Number.isFinite(input.withinMs) || input.withinMs <= 0) return null;
  const start = new Date(input.startAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const snap = await getAdminDb()
    .collection("events")
    .where("contactId", "==", input.contactId)
    .where("subAccountId", "==", input.subAccountId)
    .where("bookingPageSlug", "==", input.pageSlug)
    .where("status", "==", "scheduled")
    .limit(300)
    .get();
  const now = Date.now();
  for (const d of snap.docs) {
    const e = d.data() as CalendarEvent;
    if (e.subAccountId !== input.subAccountId || e.contactId !== input.contactId || e.source !== "booking_page") continue;
    if (e.bookingPageSlug !== input.pageSlug || eventStatus(e) !== "scheduled") continue;
    const startAt = dateOf(e.startAt);
    const endAt = dateOf(e.endAt);
    const createdAt = dateOf(e.createdAt);
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) continue;
    if (startAt.getTime() !== start.getTime()) continue;
    if (!(createdAt instanceof Date) || createdAt.getTime() > now || now - createdAt.getTime() > input.withinMs) continue;
    return { eventId: d.id, startAt, endAt, assignedToName: e.assignedToName ?? null };
  }
  return null;
}

/** e.g. "Tuesday, July 28 at 10:00 AM" in the page's timezone. Fed to the LLM. */
export function formatSlotForSpeech(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}

/** Short button label, e.g. "Tue, Oct 28, 10:00 AM", in the page's timezone. */
export function formatSlotForChip(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}

function dateOf(value: unknown): Date | null {
  if (value instanceof Date) return value;
  return (value as { toDate?: () => Date } | null)?.toDate?.() ?? null;
}

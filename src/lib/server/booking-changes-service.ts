import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { isSlotAvailable, type SlotCandidate } from "@/lib/booking/availability";
import { buildEventPublicUrl, issueEventToken } from "@/lib/booking/event-token";
import { nextIcsSequence } from "@/lib/booking/ics";
import { emitBookingWebhook, fireBookingTrigger, recordBookingActivity } from "@/lib/booking/lifecycle";
import { isLongEvent } from "@/lib/booking/long-event";
import { MAX_SLOT_MINUTES } from "@/lib/booking/page-slots";
import {
  RescheduleRejected,
  rescheduleWithoutAvailabilityCheck,
  runRescheduleSideEffects,
} from "@/lib/booking/reschedule";
import { departedHostMessage, movingEventOf, resolvePageAvailability } from "@/lib/booking/resolve-availability";
import { loadGoogleBusyForEvent } from "@/lib/google-calendar/busy";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";
import { runAfterResponse } from "@/lib/server/after-response";
import { isDocId } from "@/lib/server/doc-id";
import { sendCancelNotice } from "@/lib/server/event-cancel-notice";
import { eventStatus, isImportedEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent, EventNotifySkipReason } from "@/types/events";

/**
 * Cancel and reschedule of a booking-page booking — the one service every
 * caller goes through. Attendee side: the public /e/[token] routes (the
 * token is the credential) and, later, the AI agent acting as the
 * conversation's contact. The caller's `guard` runs INSIDE the transaction
 * against the live event and decides who may act; a refusal is `invalid`
 * with nothing written and no token rotated. Imported Google events are
 * refused whatever the guard says. Operator side:
 * `rescheduleBookingAsOperator` (no availability check).
 *
 * Every reschedule's side effects (Google push, reminders, activity,
 * trigger, "Updated:" email + ICS) run through `runRescheduleSideEffects`;
 * they are awaited, so the caller's response follows them.
 */

/**
 * Return false to refuse the change (reported as `invalid`). Runs again on
 * every transaction retry, so keep it a pure check of the event.
 */
export type BookingChangeGuard = (event: CalendarEvent) => boolean;

export type CancelBookingResult =
  | { ok: true; event: CalendarEvent; alreadyCancelled: boolean }
  | { ok: false; code: "invalid" }
  | { ok: false; code: "bad_state"; message: string }
  | { ok: false; code: "error" };

export type RescheduleBookingResult =
  | { ok: true; newStart: Date; newEnd: Date; newToken: string; publicEventUrl: string }
  | { ok: false; code: "invalid" }
  /** The requested time itself is unusable (the routes' 400). */
  | { ok: false; code: "bad_request"; message: string }
  | { ok: false; code: "bad_state"; message: string }
  | { ok: false; code: "slot_taken" }
  | { ok: false; code: "error" };

class GuardRefused extends Error {}
class BadState extends Error {}
class SlotConflict extends Error {}

// The stack (message included), never the raw object: SDK errors can carry request headers.
const errText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

export async function cancelBooking(input: {
  eventId: string;
  guard: BookingChangeGuard;
  /** Appended to the activity row and webhook, e.g. "by attendee". */
  note: string;
}): Promise<CancelBookingResult> {
  if (!isDocId(input.eventId)) return { ok: false, code: "invalid" };
  const db = getAdminDb();
  const ref = db.collection("events").doc(input.eventId);

  let result: { event: CalendarEvent; alreadyCancelled: boolean };
  try {
    // Transactional read + flip so concurrent cancels collapse.
    result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new GuardRefused();
      // Id from the snapshot: not every event doc stores an `id` field.
      const event = { ...(snap.data() as CalendarEvent), id: snap.id };
      if (isImportedEvent(event) || !input.guard(event)) throw new GuardRefused();
      const status = eventStatus(event);
      if (status === "cancelled") {
        // Idempotent — a repeat cancel answers success and does nothing:
        // the email, workflows and webhook ran on the first one.
        return { event, alreadyCancelled: true };
      }
      if (status === "completed" || status === "no_show") {
        throw new BadState("This meeting has already taken place.");
      }
      txn.update(ref, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledByVisitor: true,
        cancelReason: "by_visitor",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { event, alreadyCancelled: false };
    });
  } catch (err) {
    if (err instanceof GuardRefused) return { ok: false, code: "invalid" };
    if (err instanceof BadState) return { ok: false, code: "bad_state", message: err.message };
    console.error(`[booking-changes] cancel txn failed event=${input.eventId}`, errText(err));
    return { ok: false, code: "error" };
  }

  if (!result.alreadyCancelled) {
    await runCancelSideEffects(result.event, input.note);
    await pushBookingToGoogle(result.event.id);
  }
  return { ok: true, ...result };
}

/** Attendee email, activity row, `event_cancelled` trigger, webhook. */
async function runCancelSideEffects(event: CalendarEvent, note: string): Promise<void> {
  if (!event.contactId) return;
  await sendCancelNotice(event, undefined, "by_visitor");
  const { id, agencyId, subAccountId, contactId } = event;
  const bookingPageSlug = event.bookingPageSlug ?? null;
  const title = event.title || "Meeting";
  await recordBookingActivity({ id, title, contactId, bookingPageSlug, subAccountId }, "booking_cancelled", {
    extra: note,
  });
  await fireBookingTrigger({ id, agencyId, subAccountId, contactId, bookingPageSlug }, "event_cancelled");
  runAfterResponse(() =>
    emitBookingWebhook({ eventId: id, agencyId, subAccountId, type: "booking_cancelled", cancelReason: note }),
  );
}

/**
 * Moves startAt/endAt in place (event id, automations and history stay),
 * rotates the public token (old links die), and runs the reschedule side
 * effects. Only slot-holding events (scheduled / awaiting_payment) qualify;
 * a payment-pending event stays pending and its hold isn't extended.
 *
 * The new time is re-verified through the same resolver the booking used,
 * as a moved booking: its own host(s) and service, its current slot not
 * busy, the hosts' Google busy included.
 */
export async function rescheduleBooking(input: {
  eventId: string;
  newStart: Date;
  /** Null = keep the booking's current length. */
  newEnd: Date | null;
  guard: BookingChangeGuard;
}): Promise<RescheduleBookingResult> {
  const { eventId, newStart } = input;
  if (!isDocId(eventId)) return { ok: false, code: "invalid" };
  if (Number.isNaN(newStart.getTime()) || newStart.getTime() <= Date.now()) {
    return { ok: false, code: "bad_request", message: "Choose a time in the future." };
  }
  if (input.newEnd && !(input.newEnd.getTime() > newStart.getTime())) {
    return { ok: false, code: "bad_request", message: "Pick a valid new time." };
  }

  const db = getAdminDb();
  const eventRef = db.collection("events").doc(eventId);

  // The hosts' Google busy (SP3 G2), loaded BEFORE the transaction: an
  // external call inside one repeats on every contention retry. Without an
  // end, the window covers the longest booking a slot can be.
  const busyTo = input.newEnd ?? new Date(newStart.getTime() + MAX_SLOT_MINUTES * 60_000);
  const externalBusy = await loadGoogleBusyForEvent(
    eventId,
    new Date(newStart.getTime() - 1),
    new Date(busyTo.getTime() + 1),
  );

  let outcome: { newToken: string; page: BookingPage; event: CalendarEvent; newEnd: Date };
  try {
    outcome = await db.runTransaction(async (txn) => {
      const eventSnap = await txn.get(eventRef);
      if (!eventSnap.exists) throw new GuardRefused();
      const event = { ...(eventSnap.data() as CalendarEvent), id: eventSnap.id };
      if (isImportedEvent(event) || !input.guard(event)) throw new GuardRefused();
      const status = eventStatus(event);
      if (status !== "scheduled" && status !== "awaiting_payment") {
        throw new BadState(
          status === "cancelled"
            ? "This booking was cancelled. Please re-book."
            : "This meeting can't be rescheduled.",
        );
      }
      if (!event.bookingPageSlug) {
        throw new BadState("Reschedule isn't available for this booking.");
      }

      // Load the booking page inside the txn so its config is the same
      // one used to verify availability.
      const pageSnap = await txn.get(
        db.doc(`subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`),
      );
      if (!pageSnap.exists) {
        throw new BadState("The booking page is no longer available. Please cancel and re-book later.");
      }
      const page = pageSnap.data() as BookingPage;
      const departed = await departedHostMessage(page, event);
      if (departed) throw new BadState(departed);

      const moving = movingEventOf(eventRef.id, event);
      let newEnd = input.newEnd;
      if (!newEnd) {
        // The stored length is client-writable; movingEventOf bounds it (0 = unknown).
        if (!moving.durationMinutes) throw new BadState("Pick a valid new time.");
        newEnd = new Date(newStart.getTime() + moving.durationMinutes * 60_000);
      }

      // A team booking is checked against its own host's calendar only —
      // not every host's (a collective one against all of its hosts); a
      // hostless one against every event, as it was booked.
      const free = await resolvePageAvailability({
        subAccountId: event.subAccountId,
        page,
        now: new Date(),
        fromInstant: new Date(newStart.getTime() - 1),
        toInstant: new Date(newEnd.getTime() + 1),
        movingEvent: moving,
        serviceId: event.serviceId ?? null,
        externalBusy,
        txn,
      });
      const candidate: SlotCandidate = { startAt: newStart, endAt: newEnd };
      if (!isSlotAvailable(candidate, free)) throw new SlotConflict();

      const { token: newRawToken, hash: newHash } = issueEventToken(eventRef.id);
      const icsSequence = nextIcsSequence(event);
      txn.update(eventRef, {
        startAt: newStart,
        endAt: newEnd,
        publicTokenHash: newHash,
        icsSequence,
        isLong: isLongEvent(newStart, newEnd),
        rescheduledAt: FieldValue.serverTimestamp(),
        rescheduleCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { newToken: newRawToken, page, event: { ...event, publicTokenHash: newHash, icsSequence }, newEnd };
    });
  } catch (err) {
    if (err instanceof GuardRefused) return { ok: false, code: "invalid" };
    if (err instanceof BadState) return { ok: false, code: "bad_state", message: err.message };
    if (err instanceof SlotConflict) return { ok: false, code: "slot_taken" };
    console.error(`[booking-changes] reschedule txn failed event=${eventId}`, errText(err));
    return { ok: false, code: "error" };
  }

  const { newToken, event, page, newEnd } = outcome;
  const publicEventUrl = buildEventPublicUrl(newToken);
  await runRescheduleSideEffects({
    event, page, newRawToken: newToken, publicEventUrl, startAt: newStart, endAt: newEnd, actor: "visitor",
  });
  return { ok: true, newStart, newEnd, newToken, publicEventUrl };
}

/**
 * Operator move: the operator is trusted to have picked a sane time, so no
 * availability check (see `rescheduleWithoutAvailabilityCheck`, which
 * throws `RescheduleRejected` for the caller to map). Reports whether the
 * visitor got the "Updated:" email — the rotated token killed their link.
 */
export async function rescheduleBookingAsOperator(
  eventId: string,
  newStart: Date,
  newEnd: Date,
): Promise<{
  event: CalendarEvent;
  notify: { emailSent: boolean; emailSkipReason?: EventNotifySkipReason };
}> {
  if (!isDocId(eventId)) throw new RescheduleRejected(404, "Event not found.");
  const { event, newToken, page } = await rescheduleWithoutAvailabilityCheck(eventId, newStart, newEnd);
  const notify = await runRescheduleSideEffects({
    event,
    page,
    newRawToken: newToken,
    publicEventUrl: buildEventPublicUrl(newToken),
    startAt: newStart,
    endAt: newEnd,
    actor: "operator",
  });
  return { event, notify };
}

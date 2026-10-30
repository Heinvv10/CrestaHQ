import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { loadEventContact } from "@/lib/server/tenant-ref";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { issueEventToken } from "@/lib/booking/event-token";
import { generateIcs, nextIcsSequence } from "@/lib/booking/ics";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { renderBookingConfirmationEmail } from "@/lib/booking/email";
import {
  fireBookingTrigger,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import { eventSource, eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent, EventNotifySkipReason } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";
import { isLongEvent } from "@/lib/booking/long-event";

/**
 * Who moved the booking. Threaded through so the activity-timeline row can
 * tell the two reschedule paths apart: the public token-authenticated
 * visitor endpoint and the authenticated operator route.
 */
export type RescheduleActor = "visitor" | "operator";

export class RescheduleRejected extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    /** Machine-readable reason, when the caller needs to branch on it. */
    public readonly code?: "no_change",
  ) {
    super(message);
  }
}

/**
 * Move a booking-page event's time WITHOUT re-checking slot availability —
 * for the operator route, which trusts the operator to have picked a sane
 * time (GHL lets an operator override availability the same way). The
 * attendee's reschedule (`rescheduleBooking` in booking-changes-service)
 * does its own availability-checked transaction instead and stamps these
 * same fields inline.
 *
 * Validates, before anything is written or the token rotated: the event
 * exists, is a booking-page event (manual events have no reschedule
 * bookkeeping to apply), is still in a slot-occupying status (scheduled /
 * awaiting_payment), its booking page still exists (same refusal as the
 * public route — the reminders and email are built from it), and the time
 * actually changes (400 `no_change`).
 */
export async function rescheduleWithoutAvailabilityCheck(
  eventId: string,
  newStart: Date,
  newEnd: Date,
): Promise<{ event: CalendarEvent; newToken: string; page: BookingPage }> {
  const db = getAdminDb();
  const eventRef = db.collection("events").doc(eventId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(eventRef);
    if (!snap.exists) {
      throw new RescheduleRejected(404, "Event not found.");
    }
    // Id from the path: the side effects key reminders, the activity row
    // and the trigger off `event.id`, and not every event doc stores one.
    const event = { ...snap.data(), id: eventRef.id } as CalendarEvent;
    if (eventSource(event) !== "booking_page") {
      throw new RescheduleRejected(
        400,
        "Only booking-page events can be rescheduled this way.",
      );
    }
    const status = eventStatus(event);
    if (status !== "scheduled" && status !== "awaiting_payment") {
      throw new RescheduleRejected(
        409,
        "This booking can't be rescheduled anymore.",
      );
    }
    if (!event.bookingPageSlug) {
      throw new RescheduleRejected(409, "Reschedule isn't available for this booking.");
    }
    const pageSnap = await txn.get(
      db.doc(`subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`),
    );
    if (!pageSnap.exists) {
      throw new RescheduleRejected(
        409,
        "This booking's page no longer exists — cancel and rebook instead.",
      );
    }
    const currentStart = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const currentEnd = (event.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (
      currentStart?.getTime() === newStart.getTime() &&
      currentEnd?.getTime() === newEnd.getTime()
    ) {
      throw new RescheduleRejected(400, "That's already the booking's time.", "no_change");
    }
    const { token: newRawToken, hash: newHash } = issueEventToken(eventRef.id);
    const icsSequence = nextIcsSequence(event);
    // A literal, not increment(1): the transaction read the current count, and
    // the operator route reports the stored value back.
    const rescheduleCount = (event.rescheduleCount ?? 0) + 1;
    txn.update(eventRef, {
      startAt: newStart,
      endAt: newEnd,
      publicTokenHash: newHash,
      icsSequence,
      isLong: isLongEvent(newStart, newEnd),
      rescheduledAt: FieldValue.serverTimestamp(),
      rescheduleCount,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      event: { ...event, publicTokenHash: newHash, icsSequence, rescheduleCount },
      newToken: newRawToken,
      page: pageSnap.data() as BookingPage,
    };
  });
}

/**
 * The side effects of ANY successful reschedule, regardless of actor or
 * which route wrote the new time: re-publish reminders with a fresh nonce,
 * record the activity row, fire `booking.rescheduled`, and mail the
 * visitor an updated confirmation + ICS. Extracted from the public
 * reschedule route so the operator route gets the identical bookkeeping
 * instead of a raw field write.
 *
 * Returns whether the "Updated:" email went out. It matters more than for
 * other notifications: the token was just rotated, so a visitor who isn't
 * emailed is left holding a dead manage link — the operator must be told.
 */
export async function runRescheduleSideEffects(args: {
  event: CalendarEvent;
  page: BookingPage | undefined;
  newRawToken: string;
  publicEventUrl: string;
  startAt: Date;
  endAt: Date;
  actor: RescheduleActor;
}): Promise<{ emailSent: boolean; emailSkipReason?: EventNotifySkipReason }> {
  const db = getAdminDb();
  const { event, page, newRawToken, publicEventUrl, startAt, endAt, actor } =
    args;
  await pushBookingToGoogle(event.id);
  // The push may have just stored the booking's Google Meet link (a room
  // made now, or found after an earlier push timed out): mail that one.
  let meetingUrl = event.meetingUrl ?? null;
  try {
    const fresh = await db.collection("events").doc(event.id).get();
    meetingUrl = (fresh.data() as CalendarEvent | undefined)?.meetingUrl ?? meetingUrl;
  } catch (err) {
    console.warn("[booking/reschedule] post-push read failed", err instanceof Error ? err.message : String(err));
  }

  // Re-publish reminder callbacks with a fresh schedule nonce so the
  // QStash dedup key doesn't collapse onto the previous ones.
  if (page?.remindersEnabled) {
    await scheduleEventReminders({
      eventId: event.id,
      startAt,
      reminderOffsetsMinutes: page.reminderOffsetsMinutes,
      rawToken: newRawToken,
      pendingPayment: eventStatus(event) === "awaiting_payment",
      scheduleNonce: Date.now().toString(36),
    });
  }

  // Activity + automation trigger.
  if (event.contactId) {
    await recordBookingActivity(
      {
        id: event.id,
        title: event.title || "Meeting",
        contactId: event.contactId,
        bookingPageSlug: event.bookingPageSlug ?? null,
        subAccountId: event.subAccountId,
      },
      "booking_rescheduled",
      { extra: actor === "visitor" ? null : `by ${actor}` },
    );
    await fireBookingTrigger(
      {
        id: event.id,
        agencyId: event.agencyId,
        subAccountId: event.subAccountId,
        contactId: event.contactId,
        bookingPageSlug: event.bookingPageSlug ?? null,
      },
      "event_rescheduled",
    );
  }

  // Visitor confirmation email + ICS (UPDATE, with the SEQUENCE the move
  // stored, so calendar clients overwrite the existing entry).
  if (!event.contactId) return { emailSent: false, emailSkipReason: "no_contact" };
  let contact: Contact;
  let sub: SubAccountDoc;
  try {
    const [loaded, subSnap] = await Promise.all([
      loadEventContact(event),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
    ]);
    if (!loaded || !subSnap.exists) {
      return { emailSent: false, emailSkipReason: "missing_records" };
    }
    contact = loaded;
    sub = subSnap.data() as SubAccountDoc;
  } catch (err) {
    console.warn("[booking/reschedule] contact/sub-account read failed", err);
    return { emailSent: false, emailSkipReason: "missing_records" };
  }
  if (!emailIsConfigured(sub)) {
    return { emailSent: false, emailSkipReason: "email_not_configured" };
  }
  if (!contact.email) return { emailSent: false, emailSkipReason: "no_contact_email" };
  if (contact.emailOptedOut) {
    return { emailSent: false, emailSkipReason: "contact_opted_out" };
  }
  try {
    const rendered = renderBookingConfirmationEmail({
      recipientName: contact.name ?? "",
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      page: {
        ...bookedEventLabel(page, event, startAt, endAt),
        timezone: page?.timezone ?? "UTC",
        payment: page?.payment ?? null,
        confirmationMessage: page?.confirmationMessage ?? "",
      },
      startAt,
      endAt,
      // The link and place the booking was made with (a Google Meet link
      // stays the same across a reschedule: the push only moves the event).
      meetingUrl,
      location: event.location || undefined,
      publicEventUrl,
    });
    rendered.subject = `Updated: ${rendered.subject.replace(/^Confirmed: /, "")}`;
    const appHost =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, "")
        ?.replace(/\/.*$/, "")
        ?.toLowerCase() ?? "leadstack.dev";
    const ics = generateIcs({
      uid: event.id,
      domain: appHost,
      startAt,
      endAt,
      summary: event.title || page?.name || "Meeting",
      description: page?.confirmationMessage ?? "",
      location: meetingUrl || event.location || "",
      method: "REQUEST",
      status: "CONFIRMED",
      sequence: event.icsSequence,
      attendeeEmail: contact.email,
      attendeeName: contact.name ?? undefined,
      organizerEmail: sub.replyToEmail ?? undefined,
      organizerName: sub.name ?? undefined,
    });

    if (eventStatus(event) === "awaiting_payment") {
      // Skip ICS for unconfirmed holds — same logic as the book route.
      await sendEmail({
        to: contact.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        subAccount: sub,
        meter: { subAccountId: event.subAccountId },
      });
      return { emailSent: true };
    }

    // Through the shared wrapper (it supports attachments) so the
    // From/Reply-To policy can't be bypassed by the ICS path.
    await sendEmail({
      from: tenantFrom(sub),
      to: contact.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: sub.replyToEmail ?? undefined,
      subAccount: sub,
      meter: { subAccountId: event.subAccountId },
      attachments: [
        {
          filename: "invite.ics",
          content: Buffer.from(ics, "utf-8").toString("base64"),
        },
      ],
    });
    return { emailSent: true };
  } catch (err) {
    console.warn("[booking/reschedule] confirmation send failed", err);
    return { emailSent: false, emailSkipReason: "send_failed" };
  }
}

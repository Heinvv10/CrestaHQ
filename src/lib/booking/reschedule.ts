import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { issueEventToken } from "@/lib/booking/event-token";
import { generateIcs } from "@/lib/booking/ics";
import { renderBookingConfirmationEmail } from "@/lib/booking/email";
import {
  fireBookingTrigger,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import { eventSource, eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Who moved the booking. Threaded through so the activity-timeline row and
 * (eventually) any actor-specific copy can tell the three reschedule paths
 * apart: the public token-authenticated visitor endpoint, an authenticated
 * operator route, and the public v1 API.
 */
export type RescheduleActor = "visitor" | "operator" | "api";

export class RescheduleRejected extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Move a booking-page event's time WITHOUT re-checking slot availability —
 * for the operator route and v1 API, both of which trust the caller to
 * have picked a sane time (GHL lets an operator override availability the
 * same way). The public visitor endpoint does its own availability-checked
 * transaction instead and stamps these same fields inline.
 *
 * Validates: the event exists, is a booking-page event (manual events have
 * no reschedule bookkeeping to apply), and is still in a slot-occupying
 * status (scheduled / awaiting_payment) — a cancelled or completed booking
 * can't be "rescheduled" back to life through this path.
 */
export async function rescheduleWithoutAvailabilityCheck(
  eventId: string,
  newStart: Date,
  newEnd: Date,
): Promise<{ event: CalendarEvent; newToken: string }> {
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
    const { token: newRawToken, hash: newHash } = issueEventToken(eventRef.id);
    txn.update(eventRef, {
      startAt: newStart,
      endAt: newEnd,
      publicTokenHash: newHash,
      rescheduledAt: FieldValue.serverTimestamp(),
      rescheduleCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      event: { ...event, publicTokenHash: newHash },
      newToken: newRawToken,
    };
  });
}

/**
 * The side effects of ANY successful reschedule, regardless of actor or
 * which route wrote the new time: re-publish reminders with a fresh nonce,
 * record the activity row, fire `booking.rescheduled`, and mail the
 * visitor an updated confirmation + ICS. Extracted from the public
 * reschedule route so the operator route and v1 API get the identical
 * bookkeeping instead of a raw field write.
 */
export async function runRescheduleSideEffects(args: {
  event: CalendarEvent;
  page: BookingPage | undefined;
  newRawToken: string;
  publicEventUrl: string;
  startAt: Date;
  endAt: Date;
  actor: RescheduleActor;
}): Promise<void> {
  const db = getAdminDb();
  const { event, page, newRawToken, publicEventUrl, startAt, endAt, actor } =
    args;

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

  // Visitor confirmation email + ICS (UPDATE, sequence+1 so calendar
  // clients overwrite the existing entry).
  if (!event.contactId) return;
  try {
    const [contactSnap, subSnap] = await Promise.all([
      db.collection("contacts").doc(event.contactId).get(),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
    ]);
    if (!contactSnap.exists || !subSnap.exists) return;
    const contact = contactSnap.data() as Contact;
    const sub = subSnap.data() as SubAccountDoc;
    if (!emailIsConfigured(sub)) return;
    if (!contact.email || contact.emailOptedOut) return;

    const rendered = renderBookingConfirmationEmail({
      recipientName: contact.name ?? "",
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      page: {
        name: page?.name ?? event.title ?? "Meeting",
        durationMinutes:
          page?.durationMinutes ??
          Math.max(15, Math.round((endAt.getTime() - startAt.getTime()) / 60_000)),
        timezone: page?.timezone ?? "UTC",
        payment: page?.payment ?? null,
        confirmationMessage: page?.confirmationMessage ?? "",
      },
      startAt,
      endAt,
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
      location: event.location || "",
      method: "REQUEST",
      status: "CONFIRMED",
      sequence: 1, // bump so calendar apps treat as update
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
      return;
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
  } catch (err) {
    console.warn("[booking/reschedule] confirmation send failed", err);
  }
}

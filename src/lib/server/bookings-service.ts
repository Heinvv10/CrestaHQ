import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import {
  buildEventPublicUrl,
  issueEventToken,
} from "@/lib/booking/event-token";
import { generateIcs } from "@/lib/booking/ics";
import {
  fireBookingTrigger,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import { renderBookingConfirmationEmail } from "@/lib/booking/email";
import { eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Bookings service — the single server-side path that confirms a booking held
 * in `awaiting_payment`.
 *
 * Extracted from /api/events/by-id/[id]/mark-paid so the Stripe order
 * reconciler and the operator's manual "Mark as paid" button drive the SAME
 * transition. Payments v1's rule: a card payment must never invent a second
 * confirm-path, or the token rotation, reminder scheduling, ICS confirmation
 * email, activity row and `event_paid` trigger drift between them.
 *
 * Token rotation: the visitor's payment-pending email linked the ORIGINAL
 * token. We mint a fresh one here so anyone who scraped that link can't reuse
 * it post-payment; the new confirmation email carries the new token.
 *
 * Auth stays with the callers — the route checks membership, the reconciler's
 * authority is the verified Stripe signature.
 */

export type MarkBookingPaidOutcome =
  | { ok: true; status: "scheduled"; publicEventUrl: string }
  | {
      ok: false;
      code: "not_found" | "wrong_tenant" | "bad_status" | "write_failed";
      message: string;
      status?: string;
    };

export async function markBookingPaidServerSide(input: {
  eventId: string;
  /** Refuse if the event belongs to another sub-account. */
  expectSubAccountId: string;
  /** Operator uid for the audit stamp; null when Stripe confirmed it. */
  paidByUid: string | null;
}): Promise<MarkBookingPaidOutcome> {
  const db = getAdminDb();
  const eventRef = db.collection("events").doc(input.eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return { ok: false, code: "not_found", message: "Event not found" };
  }
  const event = eventSnap.data() as CalendarEvent;

  if (event.subAccountId !== input.expectSubAccountId) {
    return {
      ok: false,
      code: "wrong_tenant",
      message: "Event belongs to a different sub-account",
    };
  }

  // Idempotency: a replayed Stripe event (or a double-clicked button) finds
  // the booking already `scheduled` and stops here, so no second confirmation
  // email and no duplicate reminder schedule.
  if (eventStatus(event) !== "awaiting_payment") {
    return {
      ok: false,
      code: "bad_status",
      message: "Only events awaiting payment can be marked paid.",
      status: eventStatus(event),
    };
  }

  const { token: newToken, hash: newHash } = issueEventToken(input.eventId);
  try {
    await eventRef.update({
      status: "scheduled",
      paidAt: FieldValue.serverTimestamp(),
      paidByUid: input.paidByUid,
      publicTokenHash: newHash,
      paymentHoldExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[bookings-service] mark-paid update failed", err);
    return {
      ok: false,
      code: "write_failed",
      message: "Couldn't mark as paid.",
    };
  }

  const updatedEvent: CalendarEvent = {
    ...event,
    id: input.eventId,
    status: "scheduled",
    publicTokenHash: newHash,
  };
  await runMarkPaidSideEffects({ event: updatedEvent, rawToken: newToken });

  return {
    ok: true,
    status: "scheduled",
    publicEventUrl: buildEventPublicUrl(newToken),
  };
}

async function runMarkPaidSideEffects(args: {
  event: CalendarEvent;
  rawToken: string;
}): Promise<void> {
  const { event, rawToken } = args;
  const db = getAdminDb();
  const startAt = (
    event.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  const endAt = (
    event.endAt as { toDate?: () => Date } | null
  )?.toDate?.();
  if (!(startAt instanceof Date) || !(endAt instanceof Date)) return;

  if (!event.contactId) return;
  let page: BookingPage | null = null;
  let sub: SubAccountDoc | null = null;
  let contact: Contact | null = null;
  try {
    const [contactSnap, subSnap, pageSnap] = await Promise.all([
      db.collection("contacts").doc(event.contactId).get(),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db
            .doc(
              `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
            )
            .get()
        : Promise.resolve(null),
    ]);
    contact = (contactSnap.exists ? contactSnap.data() : null) as Contact | null;
    sub = (subSnap.exists ? subSnap.data() : null) as SubAccountDoc | null;
    page = (pageSnap?.data() ?? null) as BookingPage | null;
  } catch (err) {
    console.warn("[events/mark-paid] tenancy read failed", err);
  }

  // Reminder pipeline + automation activity/trigger run regardless of
  // email send success.
  if (page?.remindersEnabled) {
    await scheduleEventReminders({
      eventId: event.id,
      startAt,
      reminderOffsetsMinutes: page.reminderOffsetsMinutes,
      rawToken,
      pendingPayment: false,
      scheduleNonce: "paid",
    });
  }

  await recordBookingActivity(
    {
      id: event.id,
      title: event.title || "Meeting",
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    "booking_payment_received",
    {
      paymentAmount: event.paymentAmount ?? undefined,
      paymentCurrency: event.paymentCurrency ?? undefined,
    },
  );
  await fireBookingTrigger(
    {
      id: event.id,
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    "event_paid",
  );

  if (!contact || !sub || !emailIsConfigured(sub)) return;
  if (!contact.email || contact.emailOptedOut) return;

  const publicEventUrl = buildEventPublicUrl(rawToken);
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
    sequence: 1,
    attendeeEmail: contact.email,
    attendeeName: contact.name ?? undefined,
    organizerEmail: sub.replyToEmail ?? undefined,
    organizerName: sub.name ?? undefined,
  });

  try {
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
    // Fall back to the standard wrapper without ICS so the visitor at
    // least gets the text confirmation.
    console.warn("[events/mark-paid] resend-with-ics failed, retrying without", err);
    try {
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
    } catch (err2) {
      console.warn("[events/mark-paid] confirmation send failed", err2);
    }
  }
}

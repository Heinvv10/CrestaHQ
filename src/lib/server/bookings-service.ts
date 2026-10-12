import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { recordSuppressedEmail } from "@/lib/comms/email-suppression";
import {
  buildEventPublicUrl,
  issueEventToken,
} from "@/lib/booking/event-token";
import { generateIcs, nextIcsSequence } from "@/lib/booking/ics";
import {
  fireBookingTrigger,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import { renderBookingConfirmationEmail } from "@/lib/booking/email";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";

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
  | {
      ok: true;
      status: "scheduled";
      publicEventUrl: string;
      /** With `expect`: the confirmation was not sent, its recipient changed. */
      emailWithheld?: true;
    }
  | {
      ok: false;
      code: "not_found" | "wrong_tenant" | "bad_status" | "contact_changed" | "write_failed";
      message: string;
      status?: string;
      /** On `bad_status`: the Stripe order that confirmed it, if one did. */
      paidOrderId?: string | null;
      /** On `bad_status`: when it was marked paid, if it was. */
      paidAt?: unknown;
    };

export interface BookingPaidExpect {
  contactId: string | null;
  emailTo: string | null;
  stepsFingerprints: Record<string, string>;
}

export async function markBookingPaidServerSide(input: {
  eventId: string;
  /** Refuse if the event belongs to another sub-account. */
  expectSubAccountId: string;
  /** Operator uid for the audit stamp; null when Stripe confirmed it. */
  paidByUid: string | null;
  /** The Stripe order paying for it, recorded so a redelivery knows its own. */
  paidOrderId?: string;
  /**
   * An approved agent mark-paid: what its approver reviewed. Another contact
   * on the booking refuses in the transaction (nothing changed); the
   * confirmation goes only to `emailTo` (null: none), and only these
   * workflows (id -> steps fingerprint), unchanged, start.
   */
  expect?: BookingPaidExpect;
}): Promise<MarkBookingPaidOutcome> {
  const db = getAdminDb();
  const eventRef = db.collection("events").doc(input.eventId);
  // A compare-and-set on `awaiting_payment`: a payment expiry that cancels
  // between a plain read and write would be overwritten back to
  // `scheduled` (double-booking the released slot), and a webhook racing
  // the operator's button would both confirm — two rotations, two emails.
  let confirmed: { event: CalendarEvent; token: string } | MarkBookingPaidOutcome;
  try {
    confirmed = await db.runTransaction(async (txn) => {
      const eventSnap = await txn.get(eventRef);
      if (!eventSnap.exists) {
        return { ok: false, code: "not_found", message: "Event not found" } as const;
      }
      const event = eventSnap.data() as CalendarEvent;

      if (event.subAccountId !== input.expectSubAccountId) {
        return {
          ok: false,
          code: "wrong_tenant",
          message: "Event belongs to a different sub-account",
        } as const;
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
          paidOrderId: event.paidOrderId ?? null,
          paidAt: event.paidAt ?? null,
        } as const;
      }

      if (input.expect && (event.contactId ?? null) !== input.expect.contactId) {
        return {
          ok: false,
          code: "contact_changed",
          message: "The booking's contact changed since this was reviewed.",
        } as const;
      }

      const { token, hash } = issueEventToken(input.eventId);
      const icsSequence = nextIcsSequence(event);
      txn.update(eventRef, {
        status: "scheduled",
        paidAt: FieldValue.serverTimestamp(),
        paidByUid: input.paidByUid,
        ...(input.paidOrderId ? { paidOrderId: input.paidOrderId } : {}),
        paidFromTokenHash: event.publicTokenHash ?? null,
        publicTokenHash: hash,
        paymentHoldExpiresAt: null,
        icsSequence,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        token,
        event: {
          ...event,
          id: input.eventId,
          status: "scheduled",
          publicTokenHash: hash,
          icsSequence,
        } as CalendarEvent,
      };
    });
  } catch (err) {
    console.error("[bookings-service] mark-paid update failed", err);
    return {
      ok: false,
      code: "write_failed",
      message: "Couldn't mark as paid.",
    };
  }
  if ("ok" in confirmed) return confirmed;
  const { event: updatedEvent, token: newToken } = confirmed;

  const withheld = await runMarkPaidSideEffects({
    event: updatedEvent,
    rawToken: newToken,
    expect: input.expect,
  });
  await pushBookingToGoogle(input.eventId);

  return {
    ok: true,
    status: "scheduled",
    publicEventUrl: buildEventPublicUrl(newToken),
    ...(withheld ? { emailWithheld: true as const } : {}),
  };
}

/** True when `expect` withheld the confirmation (its recipient changed). */
async function runMarkPaidSideEffects(args: {
  event: CalendarEvent;
  rawToken: string;
  expect?: BookingPaidExpect;
}): Promise<boolean> {
  const { event, rawToken, expect } = args;
  const db = getAdminDb();
  const startAt = (
    event.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  const endAt = (
    event.endAt as { toDate?: () => Date } | null
  )?.toDate?.();
  if (!(startAt instanceof Date) || !(endAt instanceof Date)) return false;

  if (!event.contactId) return false;
  let page: BookingPage | null = null;
  let sub: SubAccountDoc | null = null;
  let contact: Contact | null = null;
  try {
    const [contactDoc, subSnap, pageSnap] = await Promise.all([
      loadEventContact(event),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db
            .doc(
              `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
            )
            .get()
        : Promise.resolve(null),
    ]);
    contact = contactDoc;
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
      subAccountId: event.subAccountId,
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
    undefined,
    expect?.stepsFingerprints,
  );

  if (!contact || !sub || !emailIsConfigured(sub)) return false;
  if (!contact.email || contact.emailOptedOut) return false;
  if (expect && contact.email !== expect.emailTo) {
    console.warn(`[events/mark-paid] confirmation withheld for event=${event.id}: not the recipient the approver reviewed`);
    return true;
  }

  const publicEventUrl = buildEventPublicUrl(rawToken);
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
    sequence: event.icsSequence,
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
    // Retrying without the ICS cannot help a suppressed address.
    if (
      await recordSuppressedEmail(err, {
        contactId: event.contactId,
        eventId: event.id,
        what: "Booking confirmation",
        createdBy: "booking",
      })
    ) {
      return false;
    }
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
  return false;
}

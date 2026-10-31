import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { recordSuppressedEmail } from "@/lib/comms/email-suppression";
import { SmtpError } from "@/lib/comms/smtp";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import {
  buildEventPublicUrl,
  hashEventToken,
} from "@/lib/booking/event-token";
import { renderBookingReminderEmail } from "@/lib/booking/email";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { eventStatus, eventOccupiesSlot, isImportedEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * QStash callback for a single reminder dispatch. Scheduled at booking
 * time by `scheduleEventReminders()` (or at mark-paid for previously
 * payment-pending events). Security: QStash signature verification.
 *
 * Skip conditions (all return 200 so QStash doesn't retry):
 *   1. Event missing (deleted between schedule + fire)
 *   2. Event status no longer occupies a slot (cancelled / completed /
 *      no_show / payment_expired)
 *   3. startAt is in the past (caught a late callback)
 *   4. Token hash doesn't match stored hash — the visitor rescheduled,
 *      which rotates the token. The reschedule flow re-publishes its
 *      own callbacks; this stale one no-ops.
 *
 * QStash delivers at least once, so each reminder (offset × schedule —
 * the token changes on every reschedule) is claimed with a create-only
 * marker doc before it is sent; a redelivery finds the claim and skips.
 * A send failure that a retry could fix releases the claim and answers
 * 503 so QStash retries; a suppressed address or a refused recipient
 * keeps the claim and answers 200 — retrying cannot help.
 */

interface ReminderBody {
  eventId?: string;
  offsetMinutes?: number;
  token?: string;
}

export async function POST(request: Request) {
  const signature = request.headers.get("Upstash-Signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const rawBody = await request.text();
  const ok = await verifyQStashSignature(signature, rawBody);
  if (!ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: ReminderBody;
  try {
    body = JSON.parse(rawBody) as ReminderBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const eventId = body.eventId;
  const offsetMinutes = body.offsetMinutes;
  const token = body.token;
  if (
    !eventId ||
    typeof offsetMinutes !== "number" ||
    !token ||
    typeof token !== "string"
  ) {
    return NextResponse.json(
      { error: "eventId, offsetMinutes, and token are required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const eventSnap = await db.collection("events").doc(eventId).get();
  if (!eventSnap.exists) {
    return NextResponse.json({ ok: true, skipped: "missing" });
  }
  const event = eventSnap.data() as CalendarEvent;
  // A member's own Google event is not a booking: nobody is reminded of it.
  if (isImportedEvent(event)) {
    return NextResponse.json({ ok: true, skipped: "imported" });
  }
  const status = eventStatus(event);
  if (!eventOccupiesSlot(status)) {
    return NextResponse.json({ ok: true, skipped: `status:${status}` });
  }
  if (status === "awaiting_payment") {
    // The deferred-schedule path on mark-paid creates fresh callbacks
    // when payment lands; a stale awaiting_payment reminder is by
    // definition obsolete.
    return NextResponse.json({ ok: true, skipped: "awaiting_payment" });
  }
  const startAt = (
    event.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  if (!(startAt instanceof Date) || startAt.getTime() <= Date.now()) {
    return NextResponse.json({ ok: true, skipped: "past" });
  }
  if (event.publicTokenHash && event.publicTokenHash !== hashEventToken(token)) {
    // Reschedule rotated the token. The new schedule already published
    // its own callbacks; nothing to do here.
    return NextResponse.json({ ok: true, skipped: "rotated" });
  }

  if (!event.contactId) {
    return NextResponse.json({ ok: true, skipped: "no_contact" });
  }
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
  // A contact outside the event's sub-account is treated as missing.
  if (
    !contactSnap.exists ||
    !subSnap.exists ||
    contactSnap.data()?.subAccountId !== event.subAccountId
  ) {
    return NextResponse.json({ ok: true, skipped: "tenancy_missing" });
  }
  const contact = contactSnap.data() as Contact;
  if (!contact.email || contact.emailOptedOut) {
    return NextResponse.json({ ok: true, skipped: "opt_out_or_no_email" });
  }
  const sub = subSnap.data() as SubAccountDoc;
  if (!emailIsConfigured(sub)) {
    return NextResponse.json({ ok: true, skipped: "email_not_configured" });
  }

  // Booking-page may have been deleted since the schedule landed. Fall
  // back to event-level defaults so the reminder still sends sensibly.
  const page = (pageSnap?.data() ?? null) as BookingPage | null;
  const endAt = (
    event.endAt as { toDate?: () => Date } | null
  )?.toDate?.() ?? new Date(startAt.getTime() + 30 * 60_000);

  const rendered = renderBookingReminderEmail(
    {
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
      location: event.location || undefined,
      // Snapshot from the event (set at booking time) — falls back to the
      // page's current value so legacy events created before the field
      // shipped still get the meeting link from the page config.
      meetingUrl: event.meetingUrl ?? page?.meetingUrl ?? null,
      publicEventUrl: buildEventPublicUrl(token),
    },
    offsetMinutes,
  );

  // Claimed immediately before the send, so nothing that can throw sits
  // between the claim and the send; released on every failure a retry
  // could fix.
  const claimRef = db.doc(
    `events/${eventId}/reminderSends/${offsetMinutes}_${hashEventToken(token).slice(0, 16)}`,
  );
  try {
    await claimRef.create({
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      claimedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 6) {
      return NextResponse.json({ ok: true, skipped: "already_sent" });
    }
    throw err;
  }

  let keepClaim = false;
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
    keepClaim = true;
  } catch (err) {
    const suppressed = await recordSuppressedEmail(err, {
      contactId: event.contactId,
      eventId,
      what: "Booking reminder",
      createdBy: "booking",
    });
    if (!suppressed) console.warn("[events/reminder] send failed", err);
    // SmtpError below 500 is a refusal decided before sending (e.g. a bad
    // address); anything else — provider or network — may clear on retry.
    keepClaim = suppressed || (err instanceof SmtpError && err.status < 500);
    if (!keepClaim) {
      return NextResponse.json({ error: "Send failed; retry" }, { status: 503 });
    }
  } finally {
    if (!keepClaim) {
      await claimRef.delete().catch((err: unknown) => {
        console.error("[events/reminder] claim release failed", err);
      });
    }
  }

  return NextResponse.json({ ok: true });
}

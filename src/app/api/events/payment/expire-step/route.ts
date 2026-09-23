import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { loadEventContact } from "@/lib/server/tenant-ref";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import {
  emitBookingWebhook,
  fireBookingTrigger,
  recordBookingActivity,
} from "@/lib/booking/lifecycle";
import { renderBookingCancelledEmail } from "@/lib/booking/email";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";

/**
 * QStash callback that auto-cancels an `awaiting_payment` event whose
 * hold window has lapsed. Scheduled at booking time by
 * `schedulePaymentAutoExpire()`. Security: Upstash-Signature verify.
 *
 * Skip conditions (all return 200 so QStash doesn't retry):
 *   - Event missing
 *   - Status no longer `awaiting_payment` (operator marked paid OR the
 *     visitor already cancelled)
 *   - startAt has passed (race — meeting was meant to happen)
 *
 * On expire: flips to `cancelled` with `cancelReason: "payment_expired"`,
 * emails the visitor a "slot released" note, fires `event_cancelled`.
 */

interface ExpireBody {
  eventId?: string;
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

  let body: ExpireBody;
  try {
    body = JSON.parse(rawBody) as ExpireBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const eventId = body.eventId;
  if (!eventId) {
    return NextResponse.json({ error: "eventId required" }, { status: 400 });
  }

  const db = getAdminDb();
  const ref = db.collection("events").doc(eventId);

  let expiredEvent: CalendarEvent | null = null;
  try {
    expiredEvent = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return null;
      const event = snap.data() as CalendarEvent;
      if (eventStatus(event) !== "awaiting_payment") return null;
      const startAt = (
        event.startAt as { toDate?: () => Date } | null
      )?.toDate?.();
      if (!(startAt instanceof Date) || startAt.getTime() <= Date.now()) {
        // Race: meeting already happened. Operator should clean up
        // manually — auto-cancelling a past meeting is misleading.
        return null;
      }
      txn.update(ref, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledByVisitor: false,
        cancelReason: "payment_expired",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return event;
    });
  } catch (err) {
    // 5xx so QStash retries: this expiry is scheduled once and nothing
    // sweeps a missed one, so a 200 here would hold the slot for good. The
    // transaction re-checks the status, so a retry after a paid/cancelled
    // flip is a 200 no-op.
    console.error("[events/payment/expire] txn failed", err);
    return NextResponse.json({ error: "txn_error" }, { status: 503 });
  }

  if (!expiredEvent) {
    return NextResponse.json({ ok: true, skipped: "no_action" });
  }

  // Best-effort side effects.
  await runExpireSideEffects(expiredEvent);
  await pushBookingToGoogle(ref.id);

  return NextResponse.json({ ok: true });
}

async function runExpireSideEffects(event: CalendarEvent): Promise<void> {
  if (!event.contactId) return;
  const db = getAdminDb();
  try {
    const [contact, subSnap, pageSnap] = await Promise.all([
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
    if (contact && subSnap.exists && emailIsConfigured(subSnap.data() as SubAccountDoc)) {
      const sub = subSnap.data() as SubAccountDoc;
      const page = (pageSnap?.data() ?? null) as BookingPage | null;
      const startAt = (
        event.startAt as { toDate?: () => Date } | null
      )?.toDate?.();
      const endAt = (
        event.endAt as { toDate?: () => Date } | null
      )?.toDate?.();
      if (
        contact.email &&
        !contact.emailOptedOut &&
        startAt instanceof Date &&
        endAt instanceof Date
      ) {
        const rendered = renderBookingCancelledEmail(
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
            publicEventUrl: "",
          },
          "payment_expired",
        );
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
        } catch (err) {
          console.warn("[events/payment/expire] notify send failed", err);
        }
      }
    }
  } catch (err) {
    console.warn("[events/payment/expire] side-effect read failed", err);
  }

  await recordBookingActivity(
    {
      id: event.id,
      title: event.title || "Meeting",
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
      subAccountId: event.subAccountId,
    },
    "booking_cancelled",
    { extra: "payment hold expired" },
  );
  await fireBookingTrigger(
    {
      id: event.id,
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    "event_cancelled",
  );
  void emitBookingWebhook({
    eventId: event.id,
    agencyId: event.agencyId,
    subAccountId: event.subAccountId,
    type: "booking_cancelled",
    cancelReason: "payment hold expired",
  });
}

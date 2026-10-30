import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { recordSuppressedEmail } from "@/lib/comms/email-suppression";
import { renderMeetLinkFollowUpEmail } from "@/lib/booking/email";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { eventOccupiesSlot, eventStatus, type CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types/tenancy";

/** The once-only claim for the follow-up (reminder claims live beside it). */
const claimPath = (eventId: string) => `events/${eventId}/reminderSends/meet-link-follow-up`;

/**
 * A Meet room made AFTER the booker was told "the joining link will follow"
 * (the detached continuation of pushBookingAndGetMeetUrlWithin stored it on
 * an event that had no link): email the booker the link once, through the
 * sub-account's own sending (SMTP or Resend, suppression-checked), and mark
 * the booking's meet_link_missing timeline row resolved. Claimed once per
 * event, so a second detached push can't send twice. Never throws.
 */
export async function sendMeetLinkFollowUp(eventId: string, meetUrl: string): Promise<void> {
  try {
    const db = getAdminDb();
    const snap = await db.collection("events").doc(eventId).get();
    if (!snap.exists) return;
    const event = { ...(snap.data() as CalendarEvent), id: eventId };
    // Only for a live booking still holding this very link.
    if (!eventOccupiesSlot(eventStatus(event)) || event.meetingUrl !== meetUrl || !event.contactId) return;

    const [contact, subSnap, pageSnap] = await Promise.all([
      loadEventContact(event),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db.doc(`subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`).get()
        : Promise.resolve(null),
    ]);
    const sub = (subSnap.exists ? subSnap.data() : null) as SubAccountDoc | null;
    const page = (pageSnap?.data() ?? null) as BookingPage | null;
    if (!sub || !emailIsConfigured(sub) || !contact?.email || contact.emailOptedOut) return;

    try {
      await db.doc(claimPath(eventId)).create({
        agencyId: event.agencyId,
        subAccountId: event.subAccountId,
        claimedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 6) {
        console.warn(`[booking/meet-link] follow-up claim failed event=${eventId}`, err instanceof Error ? err.message : String(err));
      }
      return; // 6 = ALREADY_EXISTS: already sent
    }

    const startAt = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (event.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) return;
    const rendered = renderMeetLinkFollowUpEmail({
      recipientName: contact.name ?? "",
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      pageName: bookedEventLabel(page, event, startAt, endAt).name,
      timezone: page?.timezone ?? "UTC",
      startAt,
      meetingUrl: meetUrl,
    });
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
      const suppressed = await recordSuppressedEmail(err, {
        contactId: event.contactId,
        eventId,
        what: "Google Meet link",
        createdBy: "booking",
      });
      if (!suppressed) console.warn(`[booking/meet-link] follow-up send failed event=${eventId}`, err instanceof Error ? err.message : String(err));
      return;
    }

    const rows = await db
      .collection("contacts")
      .doc(event.contactId)
      .collection("activities")
      .where("type", "==", "meet_link_missing")
      .where("meta.eventId", "==", eventId)
      .get();
    await Promise.all(
      rows.docs.map((d) =>
        d.ref.update({
          content: "The Google Meet link was made after the booking and has been emailed to the customer.",
          "meta.resolved": true,
          "meta.resolvedAt": FieldValue.serverTimestamp(),
        }),
      ),
    );
  } catch (err) {
    console.warn(`[booking/meet-link] follow-up failed event=${eventId}`, err instanceof Error ? err.message : String(err));
  }
}

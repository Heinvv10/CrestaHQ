import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { recordSuppressedEmail } from "@/lib/comms/email-suppression";
import { renderMeetLinkFollowUpEmail } from "@/lib/booking/email";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { meetLinkFollowUpClaimPath, settleMeetLinkRows } from "@/lib/booking/meet-link-missing";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { eventStatus, type CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * A Meet room made AFTER the booker was told "the joining link will follow"
 * (the detached continuation of pushBookingAndGetMeetUrlWithin stored it on
 * an event that had no link): email the booker the link once, through the
 * sub-account's own sending (SMTP or Resend, suppression-checked), and mark
 * the booking's meet_link_missing timeline row resolved. When it can't be
 * emailed (sending off, no address, opted out, suppressed, or not the
 * address an approver pinned — `pinnedEmail`) the row says so instead.
 * Claimed once per event, so a second detached push can't send twice; a
 * send that fails in a way a retry could fix releases the claim. Never throws.
 */
export async function sendMeetLinkFollowUp(
  eventId: string,
  meetUrl: string,
  opts: { pinnedEmail?: string } = {},
): Promise<void> {
  try {
    const db = getAdminDb();
    const snap = await db.collection("events").doc(eventId).get();
    if (!snap.exists) return;
    const event = { ...(snap.data() as CalendarEvent), id: eventId };
    // Only for a confirmed booking still holding this very link — not a paid
    // hold (its confirmation, with the link, comes at mark-paid), not a
    // cancelled or finished one.
    if (eventStatus(event) !== "scheduled" || event.meetingUrl !== meetUrl || !event.contactId) return;
    const contactId = event.contactId;
    const startAt = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (event.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) return;

    const [contact, subSnap, pageSnap] = await Promise.all([
      loadEventContact(event),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db.doc(`subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`).get()
        : Promise.resolve(null),
    ]);
    const sub = (subSnap.exists ? subSnap.data() : null) as SubAccountDoc | null;
    const page = (pageSnap?.data() ?? null) as BookingPage | null;
    const to = contact?.email ?? null;
    const pinnedAway = opts.pinnedEmail !== undefined && to !== opts.pinnedEmail;
    if (!sub || !emailIsConfigured(sub) || !to || contact?.emailOptedOut || pinnedAway) {
      if (pinnedAway) console.warn(`[booking/meet-link] follow-up withheld event=${eventId}: not the address the approver reviewed`);
      await settleMeetLinkRows(contactId, eventId, "not_emailed");
      return;
    }

    const claim = db.doc(meetLinkFollowUpClaimPath(eventId));
    try {
      await claim.create({
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

    const rendered = renderMeetLinkFollowUpEmail({
      recipientName: contact?.name ?? "",
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      pageName: bookedEventLabel(page, event, startAt, endAt).name,
      timezone: page?.timezone ?? "UTC",
      startAt,
      meetingUrl: meetUrl,
    });
    try {
      await sendEmail({
        to,
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
        contactId,
        eventId,
        what: "Google Meet link",
        createdBy: "booking",
      });
      if (suppressed) {
        await settleMeetLinkRows(contactId, eventId, "not_emailed");
        return;
      }
      // A failure a retry could fix: release the claim, leave the row open.
      console.warn(`[booking/meet-link] follow-up send failed event=${eventId}`, err instanceof Error ? err.message : String(err));
      await claim.delete().catch((e) => console.warn(`[booking/meet-link] claim release failed event=${eventId}`, e instanceof Error ? e.message : String(e)));
      return;
    }
    await settleMeetLinkRows(contactId, eventId, "sent");
  } catch (err) {
    console.warn(`[booking/meet-link] follow-up failed event=${eventId}`, err instanceof Error ? err.message : String(err));
  }
}

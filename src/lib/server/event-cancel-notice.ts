import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { emailIsConfigured } from "@/lib/comms/resend";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { renderBookingCancelledEmail } from "@/lib/booking/email";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent, EventNotifySkipReason } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The email an operator cancel sends the attendee, worked out without
 * sending it: shared by the cancel itself (event-status-service) and an
 * agent's cancel preview, which shows and pins exactly this.
 */

export type CancelNotice =
  | { ok: true; to: string; name: string; subject: string; text: string; html: string; sub: SubAccountDoc }
  | { ok: false; reason: EventNotifySkipReason };

/** What an approver reviewed: the notice's recipient and text. */
export interface CancelNoticeExpect {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function planCancelNotice(event: CalendarEvent): Promise<CancelNotice> {
  if (!event.contactId) return { ok: false, reason: "no_contact" };
  const db = getAdminDb();
  try {
    const [contact, subSnap, pageSnap] = await Promise.all([
      loadEventContact(event),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db.doc(`subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`).get()
        : Promise.resolve(null),
    ]);
    if (!contact || !subSnap.exists) {
      console.warn(`[event-status-service] missing records: contact=${!!contact} sub=${subSnap.exists} event=${event.id}`);
      return { ok: false, reason: "missing_records" };
    }
    const sub = subSnap.data() as SubAccountDoc;
    if (!emailIsConfigured(sub)) {
      console.warn(`[event-status-service] email not configured \u2014 skipping cancel notify for event=${event.id}`);
      return { ok: false, reason: "email_not_configured" };
    }
    const page = (pageSnap?.data() ?? null) as BookingPage | null;
    if (!contact.email) return { ok: false, reason: "no_contact_email" };
    if (contact.emailOptedOut) return { ok: false, reason: "contact_opted_out" };
    const startAt = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (event.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) {
      console.warn(`[event-status-service] bad timestamps event=${event.id} start=${typeof startAt} end=${typeof endAt}`);
      return { ok: false, reason: "bad_timestamps" };
    }
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
      "by_operator",
    );
    return { ok: true, to: contact.email, name: contact.name ?? "", subject: rendered.subject, text: rendered.text, html: rendered.html, sub };
  } catch (err) {
    console.warn(`[event-status-service] side-effect read failed event=${event.id}`, err);
    return { ok: false, reason: "missing_records" };
  }
}

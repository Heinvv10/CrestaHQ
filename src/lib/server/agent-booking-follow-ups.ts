import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadHostNotifyContact } from "@/lib/booking/hosts";
import { buildEventPublicUrl } from "@/lib/booking/event-token";
import { effectiveBookingLocation, meetLinkToFollow } from "@/lib/booking/location";
import { recordMeetLinkMissing } from "@/lib/booking/meet-link-missing";
import { scheduleEventReminders } from "@/lib/booking/lifecycle";
import { renderBookingConfirmationEmail, renderBookingHostNotificationEmail } from "@/lib/booking/email";
import { generateIcs } from "@/lib/booking/ics";
import { bookingConfirmationSmsBody, noteConfirmationHeld, sendBookingSms } from "@/lib/booking/sms";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { pushBookingAndGetMeetUrlWithin, pushBookingToGoogleAfterResponse } from "@/lib/google-calendar/push";
import { loadEventContact } from "@/lib/server/tenant-ref";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types/tenancy";

function appDomain(): string {
  try { return new URL(process.env.NEXT_PUBLIC_APP_URL || "https://example.com").hostname; }
  catch { return "example.com"; }
}

async function loadSubAccount(subAccountId: string): Promise<SubAccountDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as SubAccountDoc) : null;
}

/** Team mode only; best-effort. */
export async function notifyAgentBookingHosts(input: {
  subAccountId: string;
  page: BookingPage;
  created: { assignedToUid: string | null; assignedToName: string | null; hostUids?: string[] | null };
  slotStart: Date;
  slotEnd: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  notes: string;
  manageUrl: string | null;
  sub?: SubAccountDoc | null;
}): Promise<void> {
  const { created, page } = input;
  if (!created.assignedToUid || !created.assignedToName) {
    return;
  }
  for (const uid of created.hostUids ?? [created.assignedToUid]) {
    try {
      const [hostContact, sub] = await Promise.all([
        loadHostNotifyContact(input.subAccountId, uid),
        input.sub !== undefined
          ? Promise.resolve(input.sub)
          : loadSubAccount(input.subAccountId),
      ]);
      if (!hostContact || !sub || !emailIsConfigured(sub)) continue;
      const rendered = renderBookingHostNotificationEmail({
        hostName: hostContact.name,
        businessName: sub.name ?? "Booking",
        businessLogoUrl: sub.logoUrl,
        page: {
          name: page.name,
          durationMinutes: page.durationMinutes,
          timezone: page.timezone,
        },
        startAt: input.slotStart,
        endAt: input.slotEnd,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        notes: input.notes,
        manageUrl: input.manageUrl,
      });
      await sendEmail({
        to: hostContact.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        from: tenantFrom(sub),
        subAccount: sub,
        meter: { subAccountId: input.subAccountId },
      });
    } catch (err) {
      console.warn("[agent-booking] host notification send failed", err instanceof Error ? err.name : "unknown");
    }
  }
}

/** Website bookings get what the public booking page sends. Every step is independent and best-effort. */
export async function sendConversationBookingFollowUps(input: {
  subAccountId: string;
  page: BookingPage;
  eventId: string;
  contactId: string;
  created: { title: string; assignedToUid: string | null; assignedToName: string | null; hostUids?: string[] | null };
  rawToken: string;
  slotStart: Date;
  slotEnd: Date;
  name: string;
  email: string;
  phone: string;
  notes: string;
  /** Where it happens ("Video call", an address, a phone call…); "" when not set. */
  locationText: string;
  fallbackName: string;
}): Promise<void> {
  const { page, created, subAccountId } = input;
  if (!await loadEventContact({ subAccountId, contactId: input.contactId })) return;
  const publicEventUrl = buildEventPublicUrl(input.rawToken);
  const sub = await loadSubAccount(subAccountId).catch(() => null);

  let meetingUrl = page.meetingUrl ?? null;
  let bookerLocation = input.locationText;
  let pending = false;
  let confirmationWritten: () => void = () => undefined;
  const afterConfirmation = new Promise<void>(resolve => { confirmationWritten = resolve; });
  if (effectiveBookingLocation(page)?.type === "google_meet") {
    const pushed = await pushBookingAndGetMeetUrlWithin(input.eventId, { after: afterConfirmation, followUpTo: input.email || null });
    meetingUrl = pushed.meetUrl || meetingUrl;
    pending = pushed.pending;
    if (!meetingUrl) bookerLocation = meetLinkToFollow(bookerLocation);
  } else pushBookingToGoogleAfterResponse(input.eventId);
  try {
    if (input.email && sub && emailIsConfigured(sub)) {
      try {
        const rendered = renderBookingConfirmationEmail({
          recipientName: input.name,
          businessName: sub.name ?? "Booking",
          businessLogoUrl: sub.logoUrl,
          page: {
            name: page.name,
            durationMinutes: page.durationMinutes,
            timezone: page.timezone,
            payment: page.payment,
            confirmationMessage: page.confirmationMessage,
          },
          startAt: input.slotStart,
          endAt: input.slotEnd,
          meetingUrl,
          location: bookerLocation || undefined,
          publicEventUrl,
          hostName: created.assignedToName,
        });
        const ics = generateIcs({
          uid: input.eventId,
          startAt: input.slotStart,
          endAt: input.slotEnd,
          domain: appDomain(),
          summary: created.title,
          description: [
            page.confirmationMessage || "",
            created.assignedToName ? `With ${created.assignedToName}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          location: meetingUrl || bookerLocation,
          organizerEmail: sub.replyToEmail ?? undefined,
          organizerName: sub.name ?? undefined,
          attendeeEmail: input.email,
          attendeeName: input.name,
        });
        await sendEmail({
          to: input.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo: sub.replyToEmail ?? undefined,
          from: tenantFrom(sub),
          subAccount: sub,
          meter: { subAccountId },
          attachments: [{ filename: "invite.ics", content: Buffer.from(ics).toString("base64") }],
        });
      } catch (err) {
        console.warn("[agent-booking] confirmation send failed", err instanceof Error ? err.name : "unknown");
      }
    }
  
    await notifyAgentBookingHosts({
      subAccountId,
      page,
      created,
      slotStart: input.slotStart,
      slotEnd: input.slotEnd,
      customerName: input.name || input.phone || input.fallbackName,
      customerEmail: input.email,
      customerPhone: input.phone,
      notes: input.notes,
      manageUrl: publicEventUrl || null,
      sub,
    });
  
    if (page.smsRemindersEnabled && sub) {
      try {
        const sms = await sendBookingSms({
          subAccountId,
          sub,
          contactId: input.contactId,
          label: "booking confirmation",
          claimPath: `events/${input.eventId}/reminderSends/sms_confirm`,
          body: bookingConfirmationSmsBody({
            recipientName: input.name,
            businessName: sub.name ?? "us",
            pageName: page.name,
            startAt: input.slotStart,
            timezone: page.timezone,
            meetingUrl,
            publicEventUrl,
          }),
        });
        await noteConfirmationHeld(sms, input.contactId, `bsms_${input.eventId}_confirm`);
      } catch (err) {
        console.warn("[agent-booking] confirmation text failed", err instanceof Error ? err.name : "unknown");
      }
    }
  
    if (!meetingUrl && effectiveBookingLocation(page)?.type === "google_meet") {
      await recordMeetLinkMissing({ contactId: input.contactId, eventId: input.eventId,
        agencyId: page.agencyId, subAccountId, pending });
    }
  } finally { confirmationWritten(); }
  if (page.remindersEnabled || page.smsRemindersEnabled) {
    try {
      await scheduleEventReminders({
        eventId: input.eventId,
        startAt: input.slotStart,
        reminderOffsetsMinutes: page.reminderOffsetsMinutes,
        rawToken: input.rawToken,
        pendingPayment: false,
        page,
      });
    } catch (err) {
      console.warn("[agent-booking] reminder schedule failed", err instanceof Error ? err.name : "unknown");
    }
  }
}


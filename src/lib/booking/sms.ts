import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { isQuietHoursDeferred, type QuietHoursHold } from "@/lib/comms/quiet-hours";
import {
  sendSmsForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { formatStartLocal } from "@/lib/booking/email";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Booking confirmation and reminder texts. Same sender rules as the workflow
 * send_sms step: the sub-account's own Twilio number, else the shared sender
 * when the agency allows it. Every text is an AUTOMATED send, so the
 * workspace's quiet hours hold it (see lib/comms/quiet-hours.ts). Never
 * throws; a failed text never breaks a booking.
 */

export type BookingSmsResult =
  | { sent: true }
  | {
      sent: false;
      reason: string;
      /** Set with reason "quiet_hours": when the window ends. Nothing was sent. */
      hold?: QuietHoursHold;
    };

export function bookingConfirmationSmsBody(input: {
  recipientName: string;
  businessName: string;
  pageName: string;
  startAt: Date;
  timezone: string;
  meetingUrl: string | null;
  /** Where it happens (address, phone call…); absent = video or not set. */
  location?: string | null;
  publicEventUrl: string;
}): string {
  const first = input.recipientName.trim().split(/\s+/)[0];
  return [
    `${first ? `Hi ${first}, you're` : "You're"} booked: ${input.pageName} with ${input.businessName}, ${formatStartLocal(input.startAt, input.timezone)}.`,
    input.meetingUrl ? `Join: ${input.meetingUrl}` : null,
    input.location ? `Where: ${input.location}` : null,
    input.publicEventUrl ? `Reschedule or cancel: ${input.publicEventUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function bookingReminderSmsBody(input: {
  businessName: string;
  pageName: string;
  startAt: Date;
  timezone: string;
  meetingUrl: string | null;
  location?: string | null;
  publicEventUrl: string;
}): string {
  return [
    `Reminder: ${input.pageName} with ${input.businessName}, ${formatStartLocal(input.startAt, input.timezone)}.`,
    input.meetingUrl ? `Join: ${input.meetingUrl}` : null,
    input.location ? `Where: ${input.location}` : null,
    input.publicEventUrl ? `Reschedule or cancel: ${input.publicEventUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function sendBookingSms(input: {
  subAccountId: string;
  sub: SubAccountDoc;
  /** The booking's contact. Loaded through loadEventContact: a contact of another sub-account reads as missing, and nothing is written for it. */
  contactId: string;
  body: string;
  /** Activity label, e.g. "Booking confirmation". */
  label: string;
  /** Set only by a confirmation of the customer's own booking (public booking page): exempt from quiet hours for a few minutes. */
  selfTriggeredBookingAt?: Date | null;
}): Promise<BookingSmsResult> {
  const db = getAdminDb();
  let contact: Awaited<ReturnType<typeof loadEventContact>> = null;
  try {
    contact = await loadEventContact({
      contactId: input.contactId,
      subAccountId: input.subAccountId,
    });
  } catch (err) {
    console.warn("[booking/sms] contact read failed", reasonOf(err));
  }
  if (!contact) return { sent: false, reason: "no_contact" };
  if (smsSendBlock(contact)) return { sent: false, reason: "opted_out" };
  const to = contact.phone;
  if (!to) return { sent: false, reason: "no_phone" };

  const hasSms =
    subAccountTwilioIsConfigured(input.sub.twilioConfig) ||
    (smsIsConfigured() && (await agencyAllowsSharedSms(input.sub.agencyId)));
  if (!hasSms) return { sent: false, reason: "sms_not_configured" };

  try {
    const sent = await sendSmsForSubAccount({
      subAccountId: input.subAccountId,
      subAccount: input.sub,
      to,
      body: input.body,
      origin: "automated",
      selfTriggeredBookingAt: input.selfTriggeredBookingAt ?? null,
    });
    const contactRef = db.collection("contacts").doc(contact.id);
    try {
      await contactRef.collection("activities").add({
        type: "sms_sent",
        content: `SMS (${input.label}): ${input.body.length > 80 ? `${input.body.slice(0, 80)}…` : input.body}`,
        createdBy: "booking",
        meta: { sid: sent.sid, mode: sent.mode },
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("[booking/sms] activity write failed", reasonOf(err));
    }
    // Thread rows only in dedicated mode, where replies route back to us.
    if (sent.mode === "dedicated") {
      try {
        await contactRef.collection("messages").doc(sent.sid).set({
          agencyId: input.sub.agencyId,
          subAccountId: input.subAccountId,
          contactId: contact.id,
          direction: "outbound",
          status: "sent",
          body: input.body,
          from: sent.from,
          to,
          twilioMessageSid: sent.sid,
          sentByUid: "booking",
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
        await upsertConversationForMessage({
          contactId: contact.id,
          subAccountId: input.subAccountId,
          agencyId: input.sub.agencyId,
          contactName: contact.name ?? "",
          contactPhone: to,
          channel: "sms",
          direction: "outbound",
          body: input.body,
          pauseBot: false,
        });
      } catch (err) {
        console.warn("[booking/sms] thread/inbox write failed", reasonOf(err));
      }
    }
    return { sent: true };
  } catch (err) {
    if (isQuietHoursDeferred(err)) {
      return { sent: false, reason: "quiet_hours", hold: err.hold };
    }
    if (err instanceof SmsRecipientUnsubscribedError) {
      // The carrier's STOP is authoritative; record it so later sends are blocked.
      try {
        await db.doc(`contacts/${contact.id}`).update({
          smsOptedOut: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (recordErr) {
        console.warn("[booking/sms] opt-out record failed", reasonOf(recordErr));
      }
      return { sent: false, reason: "carrier_unsubscribed" };
    }
    console.warn("[booking/sms] send failed", reasonOf(err));
    return { sent: false, reason: "send_failed" };
  }
}

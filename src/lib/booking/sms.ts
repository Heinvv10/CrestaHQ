import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getCountryCallingCode, parsePhoneNumberFromString } from "libphonenumber-js/max";

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
import { releaseBookingSms, reserveBookingSms } from "@/lib/booking/sms-caps";
import { coercePhoneCountry } from "@/lib/contacts/phone";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Booking confirmation and reminder texts. Same sender rules as the workflow
 * send_sms step: the sub-account's own Twilio number, else the shared sender
 * when the agency allows it. Every text is an AUTOMATED send, so the
 * workspace's quiet hours hold it (see lib/comms/quiet-hours.ts). Never
 * throws; a failed text never breaks a booking.
 *
 * The public booking page lets anyone make us text a number of their choice,
 * so what goes out is fixed text plus values the operator or the system set:
 * NO booker free text (no location or address, no phone, no title) and the
 * booker's name only as one plain first name (see smsFirstName). The
 * destination must be in the sub-account's home country and is capped per
 * number and per sub-account per day (lib/booking/sms-caps.ts).
 */

export type BookingSmsResult =
  | { sent: true }
  | {
      sent: false;
      reason: string;
      /** Set with reason "quiet_hours": when the window ends. Nothing was sent. */
      hold?: QuietHoursHold;
    };

/**
 * The booker's first name, or "" when it is not a plain one: a single token of
 * letters (with marks), hyphens and apostrophes, at most 30 characters. Anything
 * else (a URL, a number, a sentence) is dropped rather than quoted in a text.
 */
export function smsFirstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.length <= 30 && /^[\p{L}][\p{L}\p{M}'\u2019-]*$/u.test(first) ? first : "";
}

/** The meeting link when it is a plain https URL, else null. */
function joinUrl(url: string | null): string | null {
  if (!url || url.length > 300) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function bookingConfirmationSmsBody(input: {
  recipientName: string;
  businessName: string;
  pageName: string;
  startAt: Date;
  timezone: string;
  meetingUrl: string | null;
  publicEventUrl: string;
}): string {
  const first = smsFirstName(input.recipientName);
  const join = joinUrl(input.meetingUrl);
  return [
    `${first ? `Hi ${first}, you're` : "You're"} booked: ${input.pageName} with ${input.businessName}, ${formatStartLocal(input.startAt, input.timezone)}.`,
    join ? `Join: ${join}` : null,
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
  publicEventUrl: string;
}): string {
  const join = joinUrl(input.meetingUrl);
  return [
    `Reminder: ${input.pageName} with ${input.businessName}, ${formatStartLocal(input.startAt, input.timezone)}.`,
    join ? `Join: ${join}` : null,
    input.publicEventUrl ? `Reschedule or cancel: ${input.publicEventUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * `raw` as E.164 when it is a valid MOBILE number whose country calling code
 * is the home country's (the workspace's `defaultPhoneCountry`, US when unset),
 * else null. A national number is read in the home country; a "+" number keeps its
 * own. Calling codes are shared (+1 covers the US and Canada): the check is on
 * the code, which is what a toll route is priced by.
 */
export function homeCountryE164(raw: string, homeCountry: string | null | undefined): string | null {
  const home = coercePhoneCountry(homeCountry);
  // The parser is lenient: it reads letters as keypad digits and drops an extension.
  if (!/^[+\d\s().-]+$/.test(raw.trim())) return null;
  const parsed = parsePhoneNumberFromString(raw.trim(), home);
  if (!parsed?.isValid()) return null;
  // Texts go to mobiles. Premium-rate, toll-free, shared-cost, short and
  // unclassified numbers are where toll fraud lives, so they are refused.
  const type = parsed.getType();
  if (type !== "MOBILE" && type !== "FIXED_LINE_OR_MOBILE") return null;
  // The metadata accepts some very short ranges (+27 82 123 reads as a mobile).
  if (parsed.nationalNumber.length < 7) return null;
  try {
    return parsed.countryCallingCode === getCountryCallingCode(home) ? parsed.number : null;
  } catch {
    return null;
  }
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
  /**
   * Create-only claim doc of THIS text (a redelivery finds it and sends nothing),
   * created in the same transaction that takes the daily cap slots. Released
   * again when quiet hours hold the text.
   */
  claimPath?: string;
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
  if (!contact.phone) return { sent: false, reason: "no_phone" };
  const to = homeCountryE164(contact.phone, input.sub.defaultPhoneCountry);
  if (!to) {
    try {
      await db.collection("contacts").doc(contact.id).collection("activities").add({
        type: "note_added",
        content: `${input.label} text not sent: the number is not a valid number in this workspace's home country.`,
        createdBy: "booking",
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("[booking/sms] refusal note write failed", reasonOf(err));
    }
    return { sent: false, reason: "number_not_allowed" };
  }

  const hasSms =
    subAccountTwilioIsConfigured(input.sub.twilioConfig) ||
    (smsIsConfigured() && (await agencyAllowsSharedSms(input.sub.agencyId)));
  if (!hasSms) return { sent: false, reason: "sms_not_configured" };

  const target = { subAccountId: input.subAccountId, agencyId: input.sub.agencyId, to, claimPath: input.claimPath };
  const reserved = await reserveBookingSms(target);
  if (!reserved.ok) {
    if (reserved.reason !== "already_sent") {
      console.warn(`[booking/sms] not sent: ${reserved.reason} sub=${input.subAccountId}`);
    }
    return { sent: false, reason: reserved.reason };
  }

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
      await releaseBookingSms(target, reserved.day);
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

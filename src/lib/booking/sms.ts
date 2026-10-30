import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getCountryCallingCode, parsePhoneNumberFromString } from "libphonenumber-js/max";

import { getAdminDb } from "@/lib/firebase/admin";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { formatHoldUntil, isQuietHoursDeferred, quietHoursHold, type QuietHoursHold } from "@/lib/comms/quiet-hours";
import { writeHoldActivity } from "@/lib/comms/quiet-hours-hold";
import {
  sendSmsForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { formatStartLocal } from "@/lib/booking/email";
import { jitter, releaseBookingSms, reserveBookingSms } from "@/lib/booking/sms-caps";
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
 * letters (with marks), at most one hyphen, each part 1 to 15 letters with at
 * most one apostrophe inside it ("Mary-Anne", "O'Neil"). Anything else (a URL, a
 * number, a sentence, a hyphenated slogan such as "Hi-your-bank-account-is-locked")
 * is dropped rather than quoted in a text.
 */
export function smsFirstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const parts = first.split("-");
  if (parts.length > 2) return "";
  const plain = parts.every((part) => {
    const letters = part.replace(/['\u2019]/g, "");
    return letters.length >= 1 && letters.length <= 15 && /^\p{L}[\p{L}\p{M}]*(?:['\u2019][\p{L}\p{M}]+)?$/u.test(part);
  });
  return plain ? first : "";
}

/**
 * The meeting link when it is a plain https URL, else null. The PARSED form is
 * returned, never the stored string: the URL parser drops tabs and line breaks
 * and percent-encodes spaces, so a control character cannot start a new line
 * of the text.
 */
function joinUrl(url: string | null): string | null {
  if (!url || url.length > 300) return null;
  try {
    const u = new URL(url);
    // No credentials in the link (https://bank.example@evil.example/ reads as the bank).
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
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

/** The US and Canada share +1 and one domestic network; a workspace in either texts both. */
const NANP_HOME = new Set(["US", "CA"]);

/**
 * `raw` as E.164 when it is a valid MOBILE number in the home country (the
 * workspace's `defaultPhoneCountry`, US when unset), else null. A national
 * number is read in the home country; a "+" number keeps its own. The number's
 * REGION must be the home country, not just its calling code: +1 also covers
 * Jamaica, the Bahamas and the other Caribbean NANP countries, whose rates are
 * not domestic. The one exception is US/CA, which accept each other.
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
  const region = parsed.country;
  if (!region) return null;
  const sameRegion = region === home || (NANP_HOME.has(region) && NANP_HOME.has(home));
  try {
    return sameRegion && parsed.countryCallingCode === getCountryCallingCode(home) ? parsed.number : null;
  } catch {
    return null;
  }
}

/** A log-safe reason: Twilio's messages quote the destination number, so digit runs are masked. */
function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\+?\d[\d\s().-]{4,}\d/g, "[number]");
}

/** Why a text was not sent, as the contact's timeline says it. Consent (opted_out) and a redelivery (already_sent) are not noted. */
const UNSENT_NOTE: Record<string, string> = {
  no_phone: "the contact has no phone number",
  number_not_allowed: "the number is not a valid mobile number in this workspace's home country",
  sms_not_configured: "no SMS sender is set up for this workspace",
  send_failed: "the text could not be sent",
  carrier_unsubscribed: "the number has unsubscribed at the carrier (STOP)",
  cap_number: "the daily limit of texts to this number was reached",
  cap_subaccount: "the workspace's daily limit of booking texts was reached",
  cap_unavailable: "the daily limit could not be checked",
};

/** One timeline row on a contact the caller has already tenant-checked; a stable id (from the claim) keeps a redelivery to one row. */
async function noteUnsent(contactId: string, label: string, reason: string, claimPath: string | undefined): Promise<void> {
  const why = UNSENT_NOTE[reason];
  if (!why) return;
  try {
    const coll = getAdminDb().collection("contacts").doc(contactId).collection("activities");
    const row = {
      type: "note_added",
      content: `${label[0].toUpperCase()}${label.slice(1)} text not sent: ${why}.`,
      createdBy: "booking",
      createdAt: FieldValue.serverTimestamp(),
    };
    if (claimPath) await coll.doc(`bsms_${createHash("sha1").update(claimPath).digest("hex").slice(0, 16)}_${reason}`).set(row);
    else await coll.add(row);
  } catch (err) {
    console.warn("[booking/sms] note write failed", reasonOf(err));
  }
}

/**
 * A confirmation that quiet hours held is dropped, not parked (a late
 * "you're booked" is worse than none): the contact's timeline says so. The
 * contact was tenant-checked inside sendBookingSms, which is the only way to
 * reach this reason.
 */
export async function noteConfirmationHeld(result: BookingSmsResult, contactId: string, noteId: string): Promise<void> {
  if (result.sent || result.reason !== "quiet_hours" || !result.hold) return;
  await writeHoldActivity(
    contactId,
    `Booking confirmation text was not sent: it fell in quiet hours (until ${formatHoldUntil(result.hold)}).`,
    noteId,
  );
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
  /** The caller's own redelivery retries a `cap_unavailable` (the reminder step answers 503): do not note it as a final failure. */
  retryOnContention?: boolean;
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
  const phone = contact.phone?.trim();
  const unsent = async (reason: string): Promise<BookingSmsResult> => {
    await noteUnsent(contact.id, input.label, reason, input.claimPath);
    return { sent: false, reason };
  };
  if (!phone) return unsent("no_phone");
  const to = homeCountryE164(phone, input.sub.defaultPhoneCountry);
  if (!to) return unsent("number_not_allowed");

  const hasSms =
    subAccountTwilioIsConfigured(input.sub.twilioConfig) ||
    (smsIsConfigured() && (await agencyAllowsSharedSms(input.sub.agencyId)));
  if (!hasSms) return unsent("sms_not_configured");

  const target = { subAccountId: input.subAccountId, agencyId: input.sub.agencyId, to, claimPath: input.claimPath };
  // Quiet hours first, and pure: a held text takes no claim and no cap slot.
  const hold = quietHoursHold({ subAccount: input.sub, origin: "automated", selfTriggeredBookingAt: input.selfTriggeredBookingAt ?? null });
  if (hold) return { sent: false, reason: "quiet_hours", hold };

  let reserved = await reserveBookingSms(target);
  for (let retry = 1; retry <= 3 && !reserved.ok && reserved.reason === "cap_unavailable"; retry++) {
    await jitter(retry);
    reserved = await reserveBookingSms(target);
  }
  if (!reserved.ok) {
    if (reserved.reason === "already_sent") return { sent: false, reason: reserved.reason };
    console.warn(`[booking/sms] not sent: ${reserved.reason} sub=${input.subAccountId}`);
    if (reserved.reason === "cap_unavailable" && input.retryOnContention) return { sent: false, reason: reserved.reason };
    return unsent(reserved.reason);
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
      // Only a window boundary crossed between the check above and the send gets here.
      if (!(await releaseBookingSms(target, reserved.day))) return { sent: false, reason: "release_failed" };
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
      return unsent("carrier_unsubscribed");
    }
    console.warn("[booking/sms] send failed", reasonOf(err));
    return unsent("send_failed");
  }
}

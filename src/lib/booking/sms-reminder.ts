import "server-only";

import { FieldValue, type DocumentReference } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import { formatHoldUntil } from "@/lib/comms/quiet-hours";
import { writeHoldActivity } from "@/lib/comms/quiet-hours-hold";
import { buildEventPublicUrl, hashEventToken } from "@/lib/booking/event-token";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { bookingReminderSmsBody, sendBookingSms } from "@/lib/booking/sms";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";

export const REMINDER_STEP_PATH = "/api/events/reminder/step";

/** Channel snapshot a reminder callback carries from scheduling time. */
export interface ReminderChannels {
  email?: boolean;
  sms?: boolean;
  pageName?: string;
  timezone?: string;
}

/**
 * One reminder text, for the reminder step. Claimed once per offset and
 * schedule (a QStash redelivery must not text twice; a redelivery finds the
 * claim) inside sendBookingSms. A reminder held by quiet hours is NOT sent late: the claim is
 * released and the step is published again for when the window ends, unless
 * that is at or after the appointment's start, when the reminder is dropped.
 * The republished step re-checks everything (status, token, opt-out, the
 * page's live toggle) before it sends.
 *
 * Reminders held to the same window end would arrive together, as the same
 * text. Each republished step first claims `smswin_{token}_{windowEnd}`: the
 * first sends, the rest answer already_sent. A step that sent nothing gives
 * the window claim back (a failed send, a re-hold, a 503), so another reminder
 * held to that window can still try and the customer is not left with none.
 */
export async function deliverReminderSms(input: {
  event: CalendarEvent;
  eventId: string;
  offsetMinutes: number;
  token: string;
  sub: SubAccountDoc;
  page: BookingPage | null;
  channels: ReminderChannels | undefined;
  startAt: Date;
  endAt: Date;
  /** A republish: the window end (ms) this step waited for, and how many holds led here. */
  heldUntil?: number | null;
  attempt?: number;
}): Promise<string> {
  const { event, eventId, offsetMinutes, token, sub, page, channels, startAt, endAt } = input;
  if (!event.contactId) return "no_contact";
  const tokenKey = hashEventToken(token).slice(0, 16);
  const attempt = input.attempt ?? 0;
  const noteId = `bsms_${eventId}_${offsetMinutes}_${tokenKey}`;

  // One text per quiet-hours window end and event.
  let windowClaim: DocumentReference | null = null;
  if (input.heldUntil) {
    windowClaim = getAdminDb().doc(`events/${eventId}/reminderSends/smswin_${tokenKey}_${input.heldUntil}`);
    try {
      await windowClaim.create({ agencyId: event.agencyId, subAccountId: event.subAccountId, offsetMinutes, claimedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 6) throw err;
      // Our own earlier delivery is a redelivery, not a collapse into another offset's text.
      const holder = (await windowClaim.get()).data()?.offsetMinutes;
      if (holder !== offsetMinutes) {
        await writeHoldActivity(
          event.contactId,
          "A booking reminder text was not sent: another reminder held to the same time went instead.",
          `${noteId}_collapsed`,
        );
      }
      return "already_sent";
    }
  }
  const giveBackWindow = async () => {
    await windowClaim?.delete().catch((err: unknown) => {
      console.error("[events/reminder] window claim release failed", err instanceof Error ? err.message : String(err));
    });
  };

  let result: Awaited<ReturnType<typeof sendBookingSms>>;
  try {
    result = await sendBookingSms({
      subAccountId: event.subAccountId,
      sub,
      contactId: event.contactId,
      label: "booking reminder",
      // Claimed, and counted against the daily caps, in one transaction. Quiet
      // hours are checked first, so a held text takes neither.
      retryOnContention: true,
      claimPath: `events/${eventId}/reminderSends/sms_${offsetMinutes}_${tokenKey}`,
      body: bookingReminderSmsBody({
        businessName: sub.name ?? "us",
        // Never event.title: it carries the booker's name.
        pageName: page ? bookedEventLabel(page, event, startAt, endAt).name : (channels?.pageName ?? "your appointment"),
        startAt,
        timezone: page?.timezone ?? channels?.timezone ?? "UTC",
        meetingUrl: event.meetingUrl ?? page?.meetingUrl ?? null,
        publicEventUrl: buildEventPublicUrl(token),
      }),
    });
  } catch (err) {
    await giveBackWindow();
    throw err;
  }
  if (result.sent) return "sent";
  // Nothing went out: another reminder held to this window may still send.
  await giveBackWindow();
  const hold = result.hold;
  if (result.reason !== "quiet_hours" || !hold) return result.reason;

  if (hold.until.getTime() >= startAt.getTime()) {
    await writeHoldActivity(
      event.contactId,
      `Booking reminder text was not sent: quiet hours last until ${formatHoldUntil(hold)}, after the appointment starts.`,
      `${noteId}_dropped`,
    );
    return "quiet_hours_dropped";
  }
  const queued = await publishCallback({
    pathname: REMINDER_STEP_PATH,
    body: {
      eventId,
      offsetMinutes,
      token,
      smsOnly: true,
      heldUntil: hold.until.getTime(),
      attempt: attempt + 1,
      ...(channels ? { channels } : {}),
    },
    delaySeconds: hold.retryAfterSec,
    deduplicationId: `evt_reminder_${eventId}_${offsetMinutes}_${tokenKey}_qh${hold.until.getTime()}_a${attempt + 1}`,
  });
  await writeHoldActivity(
    event.contactId,
    queued
      ? `Booking reminder text held for quiet hours; it goes out at ${formatHoldUntil(hold)}.`
      : "Booking reminder text fell in quiet hours and could not be held, so it was NOT sent.",
    `${noteId}_held_${hold.until.getTime()}`,
  );
  return queued ? "quiet_hours_deferred" : "quiet_hours_hold_failed";
}

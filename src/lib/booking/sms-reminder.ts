import "server-only";

import { FieldValue } from "firebase-admin/firestore";

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
 * claim). A reminder held by quiet hours is NOT sent late: the claim is
 * released and the step is published again for when the window ends, unless
 * that is at or after the appointment's start, when the reminder is dropped.
 * The republished step re-checks everything (status, token, opt-out, the
 * page's live toggle) before it sends.
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
}): Promise<string> {
  const { event, eventId, offsetMinutes, token, sub, page, channels, startAt, endAt } = input;
  if (!event.contactId) return "no_contact";
  const tokenKey = hashEventToken(token).slice(0, 16);
  const claimRef = getAdminDb().doc(`events/${eventId}/reminderSends/sms_${offsetMinutes}_${tokenKey}`);
  try {
    await claimRef.create({
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      claimedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 6) return "already_sent";
    throw err;
  }

  const result = await sendBookingSms({
    subAccountId: event.subAccountId,
    sub,
    contactId: event.contactId,
    label: "booking reminder",
    body: bookingReminderSmsBody({
      businessName: sub.name ?? "us",
      pageName: page ? bookedEventLabel(page, event, startAt, endAt).name : (channels?.pageName ?? event.title ?? "Your meeting"),
      startAt,
      timezone: page?.timezone ?? channels?.timezone ?? "UTC",
      meetingUrl: event.meetingUrl ?? page?.meetingUrl ?? null,
      location: event.location || null,
      publicEventUrl: buildEventPublicUrl(token),
    }),
  });
  if (result.sent) return "sent";
  const hold = result.hold;
  if (result.reason !== "quiet_hours" || !hold) return result.reason;

  // Nothing went out: free the claim so the republished step can send.
  await claimRef.delete().catch((err: unknown) => {
    console.error("[events/reminder] sms claim release failed", err instanceof Error ? err.message : String(err));
  });
  const noteId = `bsms_${eventId}_${offsetMinutes}_${tokenKey}`;
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
      ...(channels ? { channels } : {}),
    },
    delaySeconds: hold.retryAfterSec,
    deduplicationId: `evt_reminder_${eventId}_${offsetMinutes}_${tokenKey}_qh${hold.until.getTime()}`,
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

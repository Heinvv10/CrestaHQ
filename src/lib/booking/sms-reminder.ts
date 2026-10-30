import "server-only";

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
 * page's live toggle) before it sends. Two reminders held to the same window
 * end would arrive together: only the later one (the smaller offset) is sent,
 * the earlier is dropped with a timeline note (a marker doc per event, token
 * and window end lists the offsets held to it).
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
  const holdMarker = (untilMs: number) => getAdminDb().doc(`events/${eventId}/reminderSends/smshold_${tokenKey}_${untilMs}`);

  if (input.heldUntil) {
    const held = ((await holdMarker(input.heldUntil).get()).data()?.offsets ?? []) as unknown[];
    if (held.some((o) => typeof o === "number" && o < offsetMinutes)) {
      await writeHoldActivity(
        event.contactId,
        "A booking reminder text was not sent: a later reminder was held to the same time and goes instead.",
        `bsms_${eventId}_${offsetMinutes}_${tokenKey}_superseded`,
      );
      return "superseded";
    }
  }
  const result = await sendBookingSms({
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
  if (result.sent) return "sent";
  const hold = result.hold;
  if (result.reason !== "quiet_hours" || !hold) return result.reason;

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
      heldUntil: hold.until.getTime(),
      attempt: attempt + 1,
      ...(channels ? { channels } : {}),
    },
    delaySeconds: hold.retryAfterSec,
    deduplicationId: `evt_reminder_${eventId}_${offsetMinutes}_${tokenKey}_qh${hold.until.getTime()}_a${attempt + 1}`,
  });
  // The marker is written only once the republish is queued: an entry for a
  // step that was never queued would make the earlier reminder yield to a
  // later one that never comes, and neither would send.
  if (queued) {
    await getAdminDb()
      .runTransaction(async (tx) => {
        const ref = holdMarker(hold.until.getTime());
        const offsets = (((await tx.get(ref)).data()?.offsets ?? []) as unknown[]).filter((o): o is number => typeof o === "number");
        tx.set(ref, {
          agencyId: event.agencyId,
          subAccountId: event.subAccountId,
          offsets: [...new Set([...offsets, offsetMinutes])],
        });
      })
      .catch((err: unknown) => {
        console.error("[events/reminder] hold marker write failed", err instanceof Error ? err.message : String(err));
      });
  }
  await writeHoldActivity(
    event.contactId,
    queued
      ? `Booking reminder text held for quiet hours; it goes out at ${formatHoldUntil(hold)}.`
      : "Booking reminder text fell in quiet hours and could not be held, so it was NOT sent.",
    `${noteId}_held_${hold.until.getTime()}`,
  );
  return queued ? "quiet_hours_deferred" : "quiet_hours_hold_failed";
}

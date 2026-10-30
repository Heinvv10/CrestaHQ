import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import { formatHoldUntil } from "@/lib/comms/quiet-hours";
import { writeHoldActivity } from "@/lib/comms/quiet-hours-hold";
import { buildEventPublicUrl, hashEventToken } from "@/lib/booking/event-token";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { bookingReminderSmsBody, sendBookingSms } from "@/lib/booking/sms";
import { REMINDER_STEP_PATH, REMINDER_STEP_RETRIES } from "@/lib/booking/reminder-step";
import { takeTextLock } from "@/lib/booking/sms-text-lock";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";


/** HH:MM of an instant in the page's timezone (UTC when it has none or the runtime rejects it). */
function clock(ms: number, timezone: string | undefined): string {
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  try {
    return fmt(timezone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

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
 * Reminder texts of one event are at most one per half hour: each takes
 * `smsrecent_{token}` first (sms-text-lock.ts). So two reminders that fire
 * together, held ones released at the same window end or a held one and a
 * fresh one, are one text; a lock held by a text still in flight makes the
 * other wait (503) so that a failed send leaves the other free to go.
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
  /** A republish: how many holds led here. */
  attempt?: number;
  /** QStash's last delivery: a text that still cannot be queued is noted instead of retried. */
  finalAttempt?: boolean;
}): Promise<string> {
  const { event, eventId, offsetMinutes, token, sub, page, channels, startAt, endAt } = input;
  if (!event.contactId) return "no_contact";
  const tokenKey = hashEventToken(token).slice(0, 16);
  const attempt = input.attempt ?? 0;
  const noteId = `bsms_${eventId}_${offsetMinutes}_${tokenKey}`;

  // One reminder text per event per half hour (see sms-text-lock.ts).
  const claimPath = `events/${eventId}/reminderSends/sms_${offsetMinutes}_${tokenKey}${attempt > 0 ? `_a${attempt}` : ""}`;
  const lock = await takeTextLock({
    eventId,
    tokenKey,
    agencyId: event.agencyId,
    subAccountId: event.subAccountId,
    offsetMinutes,
    claimPath,
    ownClaimExists: async () => (await getAdminDb().doc(claimPath).get()).exists,
    finalAttempt: input.finalAttempt === true,
  });
  if (!lock.ok) {
    if (lock.reason === "already_sent" && lock.collapsed) {
      const when = clock(lock.at, page?.timezone ?? channels?.timezone);
      await writeHoldActivity(
        event.contactId,
        lock.outcome === "sent"
          ? `A booking reminder text was not sent: another reminder for this booking was texted at ${when}.`
          : `A booking reminder text was not sent: another reminder for this booking was being texted at ${when} and may have gone.`,
        `${noteId}_collapsed`,
      );
    } else if (lock.reason === "lock_contended") {
      // The last delivery: nothing will retry, so the timeline says why there is no text.
      await writeHoldActivity(
        event.contactId,
        "A booking reminder text was not sent: another reminder for this booking was being sent at the same moment.",
        `${noteId}_lock_contended`,
      );
    }
    return lock.reason;
  }

  let result: Awaited<ReturnType<typeof sendBookingSms>>;
  try {
    result = await sendBookingSms({
      subAccountId: event.subAccountId,
      sub,
      contactId: event.contactId,
      label: "booking reminder",
      // Claimed, and counted against the daily caps, in one transaction. Quiet
      // hours are checked first, so a held text takes neither.
      retryOnContention: !input.finalAttempt,
      // A step that follows a hold has its own claim: if the release of the
      // earlier one ever failed, that claim is left behind and must not block it.
      claimPath,
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
    await lock.release();
    throw err;
  }
  if (result.sent) {
    await lock.markSent();
    return "sent";
  }
  // Nothing went out: another reminder may still send. (Not when our own claim
  // says this is a redelivery of a text that went: that lock is spent.)
  if (!(lock.mine && result.reason === "already_sent")) await lock.release();
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
    retries: REMINDER_STEP_RETRIES,
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

import "server-only";

import { publishCallback } from "@/lib/automations/qstash";
import { getAdminDb } from "@/lib/firebase/admin";
import { buildReviewClickUrl } from "@/lib/reviews/click-token";
import { activeReminder, type ReviewChannel } from "@/lib/reviews/constants";

/**
 * Review-request reminders (SP5 d2) — the dispatcher's side: which link a
 * request carries and scheduling its next reminder. The worker that sends a
 * reminder is `lib/reviews/reminder-run.ts`.
 *
 * Off (the default: no `reminder`, or `everyDays: null`) means `planReviewLink`
 * returns null and the dispatcher sends exactly what it always has.
 */

const DAY_S = 24 * 3600;
export const REVIEW_REMINDER_PATH = "/api/cron/review-reminder";

export interface ReviewLinkPlan {
  /** The request doc id, chosen before the send so the link can name it. */
  requestId: string;
  /** What the body's {{reviewUrl}} becomes. */
  bodyUrl: string;
  /** Whether the body carries the /rr/ link (so a click can be seen). */
  tracked: boolean;
  /** The new request's reminder state; absent on a reminder re-send. */
  reminder?: ReminderState;
}

export interface ReminderState {
  everyDays: number;
  maxRetries: number;
  attempts: number;
  nextAt: Date | null;
  state: "scheduled" | "sending" | "stopped" | "done";
  stopReason: string | null;
  lastAttemptAt: Date | null;
}

/**
 * The link plan for a dispatcher send; null when reminders are off and this is
 * not a reminder re-send. Only the bodies LeadStack writes (SMS, in-window
 * WhatsApp) can carry the tracked link — an approved template's URL is fixed.
 */
export function planReviewLink(input: {
  config: { reminder?: unknown } | null;
  channel: ReviewChannel;
  subAccountId: string;
  reviewUrl: string;
  reminderOf?: { requestId: string; tracked: boolean };
  newRequestId: () => string;
}): ReviewLinkPlan | null {
  const trackedUrl = (requestId: string) =>
    input.channel === "whatsapp_template" ? "" : buildReviewClickUrl(input.subAccountId, requestId);
  if (input.reminderOf) {
    const { requestId, tracked } = input.reminderOf;
    const url = tracked ? trackedUrl(requestId) : "";
    return { requestId, bodyUrl: url || input.reviewUrl, tracked: !!url };
  }
  const reminder = activeReminder(input.config?.reminder);
  if (!reminder) return null;
  const requestId = input.newRequestId();
  const url = trackedUrl(requestId);
  return {
    requestId,
    bodyUrl: url || input.reviewUrl,
    tracked: !!url,
    reminder: {
      ...reminder,
      attempts: 0,
      nextAt: new Date(Date.now() + reminder.everyDays * DAY_S * 1000),
      state: "scheduled",
      stopReason: null,
      lastAttemptAt: null,
    },
  };
}

/**
 * Publish reminder `attempt` for a request, `everyDays` from now. On failure the
 * reminder is stopped with `schedule_failed` — never thrown: the send it
 * follows has already happened. Returns whether it was scheduled.
 */
export async function scheduleReviewReminder(input: {
  subAccountId: string;
  requestId: string;
  attempt: number;
  everyDays: number;
}): Promise<boolean> {
  const res = await publishCallback({
    pathname: REVIEW_REMINDER_PATH,
    body: { subAccountId: input.subAccountId, requestId: input.requestId, attempt: input.attempt },
    delaySeconds: input.everyDays * DAY_S,
    deduplicationId: `rr_${input.requestId}_${input.attempt}`,
  });
  if (res) return true;
  try {
    await getAdminDb()
      .doc(`subAccounts/${input.subAccountId}/reviewRequests/${input.requestId}`)
      .update({ "reminder.state": "stopped", "reminder.stopReason": "schedule_failed", "reminder.nextAt": null });
  } catch (err) {
    const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
    console.warn(`[reviews/reminder] schedule_failed not recorded kind=${String(kind)}`);
  }
  console.warn("[reviews/reminder] reminder could not be scheduled; stopped (schedule_failed)");
  return false;
}

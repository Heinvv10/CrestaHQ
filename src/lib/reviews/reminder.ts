import "server-only";

import { publishCallback } from "@/lib/automations/qstash";
import { getAdminDb } from "@/lib/firebase/admin";
import { buildReviewClickUrl, reviewTrackingAvailable } from "@/lib/reviews/click-token";
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
 * The link plan for a dispatcher send; null — today's body, no reminder — when
 * reminders are off, the channel is not SMS (reminders are SMS-only: a
 * template's link is fixed and can't stop on a click; an in-window WhatsApp
 * dies at the 24h window), or this deployment can't make a tracked link.
 * Reminders need tracking, so they never run untracked. Never throws.
 */
export function planReviewLink(input: {
  config: { reminder?: unknown } | null;
  channel: ReviewChannel;
  subAccountId: string;
  reviewUrl: string;
  reminderOf?: { requestId: string; tracked: boolean; channel: "sms" | "whatsapp" };
  /**
   * Can a reply stop reminders? A dedicated SMS number (on the shared sender
   * inbound SMS is never stored) whose inbound webhook is set up, a contact
   * number in E.164 (so a reply is matched to the contact), and a Google
   * review link. Without all of these, no reminder.
   */
  remindable: boolean;
  newRequestId: () => string;
}): ReviewLinkPlan | null {
  const trackedUrl = (requestId: string) => {
    try {
      return input.channel === "sms" && reviewTrackingAvailable() ? buildReviewClickUrl(input.subAccountId, requestId) : "";
    } catch {
      return "";
    }
  };
  if (input.reminderOf) {
    const { requestId, tracked } = input.reminderOf;
    const url = tracked ? trackedUrl(requestId) : "";
    return { requestId, bodyUrl: url || input.reviewUrl, tracked: !!url };
  }
  const reminder = activeReminder(input.config?.reminder);
  if (!reminder || !input.remindable) return null;
  const requestId = input.newRequestId();
  // Empty for a non-SMS channel or without tracking: then no reminder at all.
  const url = trackedUrl(requestId);
  if (!url) return null;
  return {
    requestId,
    bodyUrl: url,
    tracked: true,
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
  console.warn("[reviews/reminder] reminder could not be scheduled; stopping it (schedule_failed)");
  const path = `subAccounts/${input.subAccountId}/reviewRequests/${input.requestId}`;
  const stop = { "reminder.state": "stopped", "reminder.stopReason": "schedule_failed", "reminder.nextAt": null };
  // Retried once: left "scheduled" with no message behind it, the request
  // would claim a reminder that will never come.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await getAdminDb().doc(path).update(stop);
      return false;
    } catch (err) {
      if (attempt === 2) {
        const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
        console.error(`[reviews/reminder] schedule_failed not recorded kind=${String(kind)}`);
      }
    }
  }
  return false;
}

/**
 * One reminder chain per contact: a new request with reminders on stops the
 * contact's other scheduled ones (`superseded`). Single-field query on
 * contactId, filtered here. Never throws — the send has happened.
 */
export async function supersedeOtherReminders(
  subAccountId: string,
  contactId: string,
  toHash: string,
  keepRequestId: string,
): Promise<void> {
  try {
    const db = getAdminDb();
    const log = db.collection(`subAccounts/${subAccountId}/reviewRequests`);
    // The contact's requests, and the same person's under a duplicate contact (same number hash).
    const [byContact, byNumber] = await Promise.all([log.where("contactId", "==", contactId).get(), log.where("toHash", "==", toHash).get()]);
    const docs = [...new Map([...byContact.docs, ...byNumber.docs].map((d) => [d.id, d])).values()];
    for (const d of docs) {
      if (d.id === keepRequestId) continue;
      // Re-read in a transaction: only a request STILL scheduled is superseded —
      // never a worker's stop, or one mid-send.
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(d.ref)).data();
        if ((current?.reminder as { state?: string } | undefined)?.state !== "scheduled") return;
        tx.update(d.ref, { "reminder.state": "stopped", "reminder.stopReason": "superseded", "reminder.nextAt": null });
      });
    }
  } catch (err) {
    const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
    console.error(`[reviews/reminder] superseding older reminders failed kind=${String(kind)}`);
  }
}

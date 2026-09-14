import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import { activeReminder, normalizeReviewChannel } from "@/lib/reviews/constants";
import { scheduleReviewReminder } from "@/lib/reviews/reminder";
import { reminderStopReason } from "@/lib/reviews/reminder-checks";
import { reviewTrackingAvailable } from "@/lib/reviews/click-token";
import { isGoogleReviewUrl } from "@/lib/reviews/review-url";
import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import type { SubAccountDoc } from "@/types";

/**
 * Send reminder `attempt` of a review request (SP5 d2) — the body of
 * `POST /api/cron/review-reminder`.
 *
 * Idempotent under QStash redelivery: in one transaction the request must
 * still be `scheduled` with exactly `attempt - 1` reminders sent, and the
 * attempt is claimed (`attempts = attempt`, state `sending`) BEFORE anything
 * is sent — a second delivery, concurrent or later, finds the claim and does
 * nothing. A crash mid-send leaves the request `sending`: never a double
 * message, at worst a reminder that stops.
 *
 * Stops (state `stopped`, or `done` when retries ran out) when the customer
 * clicked, reminders are off in the config now, the review link is gone, the
 * channel changed, or the dispatcher refuses the re-send (opted out, contact
 * deleted, a gate or rail that cannot send, the send failed). The re-send goes
 * through the dispatcher in reminder mode: same link, same channel rules,
 * the cooldown skipped for this request only, and no new request row.
 */

export type ReminderRunResult =
  | { outcome: "sent" }
  | { outcome: "stopped"; reason: string }
  | { outcome: "skipped"; reason: string };

const DAY_MS = 24 * 3600_000;
/** Recent thread messages read per channel to spot a reply since the request. */
const INBOUND_LOOKBACK = 20;

const stopped = (reason: string) => ({
  "reminder.state": reason === "retries_exhausted" ? "done" : "stopped",
  "reminder.stopReason": reason,
  "reminder.nextAt": null,
});

export async function runReviewReminder(input: {
  subAccountId: string;
  requestId: string;
  attempt: number;
}): Promise<ReminderRunResult> {
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${input.subAccountId}/reviewRequests/${input.requestId}`);
  const subRef = db.doc(`subAccounts/${input.subAccountId}`);

  type Claim =
    | { skip: string }
    | { stop: string }
    | {
        claimed: {
          agencyId: string;
          contactId: string;
          tracked: boolean;
          channel: "sms" | "whatsapp";
          maxRetries: number;
          everyDays: number;
        };
      };
  const claim: Claim = await db.runTransaction(async (tx) => {
    const req = (await tx.get(ref)).data();
    if (!req) return { skip: "missing" };
    const r = req.reminder as { state?: string; attempts?: number; maxRetries?: number; everyDays?: number } | undefined;
    if (!r || r.state !== "scheduled") return { skip: `state:${r?.state ?? "none"}` };
    if (r.attempts !== input.attempt - 1) return { skip: "stale_attempt" };

    const sub = ((await tx.get(subRef)).data() ?? null) as SubAccountDoc | null;
    const cfg = sub?.googleReviewConfig ?? null;
    const contactId = req.contactId as string;
    const [contactSnap, others, sms, wa] = await Promise.all([
      tx.get(db.doc(`contacts/${contactId}`)),
      tx.get(db.collection(`subAccounts/${input.subAccountId}/reviewRequests`).where("contactId", "==", contactId)),
      tx.get(db.collection(`contacts/${contactId}/messages`).orderBy("createdAt", "desc").limit(INBOUND_LOOKBACK)),
      tx.get(db.collection(`contacts/${contactId}/whatsappMessages`).orderBy("createdAt", "desc").limit(INBOUND_LOOKBACK)),
    ]);
    const inboundAt = [...sms.docs, ...wa.docs].flatMap((d) => {
      const m = d.data() as { direction?: string; createdAt?: { toMillis?: () => number } };
      const at = m.direction === "inbound" && typeof m.createdAt?.toMillis === "function" ? m.createdAt.toMillis() : null;
      return at === null ? [] : [at];
    });
    const { reason: stop, maxRetries } = reminderStopReason({
      requestId: input.requestId,
      req,
      sub: sub as unknown as Record<string, unknown> | null,
      contact: contactSnap.exists ? (contactSnap.data() as Record<string, unknown>) : null,
      contactRequests: others.docs.map((d) => ({ id: d.id, data: d.data() })),
      inboundAt,
      trackingAvailable: reviewTrackingAvailable(),
      reminder: activeReminder(cfg?.reminder),
      channel: normalizeReviewChannel(cfg?.channel) === "sms" ? "sms" : "whatsapp",
      reviewUrlConfigured: isGoogleReviewUrl(resolveReviewUrl(sub).configured ?? ""),
      dedicatedSms: subAccountTwilioIsConfigured(sub?.twilioConfig),
    });
    if (stop) {
      tx.update(ref, stopped(stop));
      return { stop };
    }
    tx.update(ref, {
      "reminder.attempts": input.attempt,
      "reminder.state": "sending",
      "reminder.lastAttemptAt": FieldValue.serverTimestamp(),
      "reminder.nextAt": null,
    });
    return {
      claimed: {
        agencyId: req.agencyId as string,
        contactId: req.contactId as string,
        tracked: req.tracked === true,
        channel: req.channel === "whatsapp" ? "whatsapp" : "sms",
        maxRetries,
        everyDays: r.everyDays ?? 1,
      },
    };
  });
  if ("skip" in claim) return { outcome: "skipped", reason: claim.skip };
  if ("stop" in claim) return { outcome: "stopped", reason: claim.stop };

  const c = claim.claimed;
  const res = await maybeSendReviewRequest({
    subAccountId: input.subAccountId,
    agencyId: c.agencyId,
    contactId: c.contactId,
    trigger: "reminder",
    reminderOf: { requestId: input.requestId, tracked: c.tracked, channel: c.channel },
  });
  if (!res.sent) {
    const reason = res.reason === "no_contact" ? "contact_deleted" : (res.reason ?? "send_failed");
    await ref.update(stopped(reason));
    return { outcome: "stopped", reason };
  }
  if (input.attempt >= c.maxRetries) {
    await ref.update(stopped("retries_exhausted"));
    return { outcome: "sent" };
  }
  await ref.update({ "reminder.state": "scheduled", "reminder.nextAt": new Date(Date.now() + c.everyDays * DAY_MS) });
  await scheduleReviewReminder({
    subAccountId: input.subAccountId,
    requestId: input.requestId,
    attempt: input.attempt + 1,
    everyDays: c.everyDays,
  });
  return { outcome: "sent" };
}

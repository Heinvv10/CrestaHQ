import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * The one writer of `subAccounts/{id}/reviewRequests` (SP5 d1): every review
 * ask any sender makes — the dispatcher, a workflow step, a broadcast email,
 * an inbox message — is logged here, once, by the code that initiated the
 * send. Never a message body, phone number or email address.
 *
 * Best-effort: a failed write costs a row, never the send that already
 * happened, and is logged by kind only.
 */

export type ReviewRequestSource = "dispatcher" | "workflow" | "broadcast" | "inbox";
export type ReviewRequestChannel = "sms" | "whatsapp" | "email";
export type ReviewRequestStatus = "sent" | "failed";

export const REVIEW_REQUEST_SOURCES: readonly ReviewRequestSource[] = ["dispatcher", "workflow", "broadcast", "inbox"];
export const REVIEW_REQUEST_CHANNELS: readonly ReviewRequestChannel[] = ["sms", "whatsapp", "email"];
export const REVIEW_REQUEST_STATUSES: readonly ReviewRequestStatus[] = ["sent", "failed"];

export interface ReviewRequestLogInput {
  agencyId: string;
  subAccountId: string;
  contactId: string;
  channel: ReviewRequestChannel;
  source: ReviewRequestSource;
  /** The dispatcher's trigger (manual / quote_paid / deal_completed); null for other sources. */
  trigger?: string | null;
  status: ReviewRequestStatus;
  /** A short machine kind for a failed send (never a provider message, which can carry a number). */
  failureKind?: string | null;
  messageSid?: string | null;
  /** The signed-in sender when a person sent it, else a label ("review-request", "workflow", "broadcast"). */
  createdByUid: string;
  /** SP5 d2, dispatcher sends while reminders are on: the pre-chosen doc id
   *  (the tracked link names it), whether the body carries that link, and the
   *  reminder state. All three absent otherwise — the row is as before. */
  id?: string;
  tracked?: boolean;
  reminder?: Record<string, unknown>;
}

export async function logReviewRequest(input: ReviewRequestLogInput): Promise<void> {
  try {
    const log = getAdminDb().collection(`subAccounts/${input.subAccountId}/reviewRequests`);
    const row = {
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: input.createdByUid,
      contactId: input.contactId,
      channel: input.channel,
      source: input.source,
      trigger: input.trigger ?? null,
      status: input.status,
      failureKind: input.status === "failed" ? (input.failureKind ?? "send_failed") : null,
      messageSid: input.messageSid || null,
      sentAt: FieldValue.serverTimestamp(),
      clickedAt: null,
      feedbackAt: null,
      ...(input.tracked !== undefined ? { tracked: input.tracked } : {}),
      ...(input.reminder ? { reminder: input.reminder } : {}),
    };
    await (input.id ? log.doc(input.id).set(row) : log.add(row));
  } catch (err) {
    const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
    console.warn(`[reviews/request-log] reviewRequests write failed source=${input.source} kind=${String(kind)}`);
  }
}

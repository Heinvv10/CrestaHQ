import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import type { QuietHoursHold } from "@/lib/comms/quiet-hours";
import type { SendReviewInput } from "@/lib/reviews/request";
import type { ActivityType } from "@/types/contacts";

/**
 * A send held for quiet hours, parked until they end.
 *
 * The workflow engine does not use this — it reschedules its own step. This
 * is for the automated senders that have no re-entry of their own: automatic
 * review requests, AI auto-replies and missed-call text-backs. What is stored
 * is what to RE-RUN, not a verdict: the release re-reads the contact and
 * re-checks opt-out (and, for a review request, every guard the dispatcher
 * runs) before anything goes out.
 *
 * `subAccounts/{id}/quietHoursHolds/{auto}` — server-only (default-deny rules).
 * Claimed pending → releasing in a transaction by the release worker, so a
 * QStash redelivery never sends twice.
 */

export const QUIET_HOURS_RELEASE_PATH = "/api/comms/quiet-hours/release";

/** An already-composed message (AI reply, missed-call text-back). */
export interface HeldMessage {
  channel: "sms" | "whatsapp";
  contactId: string;
  to: string;
  body: string;
  /** WhatsApp: the sender to reply from. Null = the workspace default. */
  senderId?: string | null;
  source: "ai_reply" | "missed_call";
}

export type HoldPayload =
  | { kind: "message"; message: HeldMessage }
  | { kind: "review_request"; request: SendReviewInput };

export interface HoldDoc {
  agencyId: string;
  subAccountId: string;
  contactId: string;
  payload: HoldPayload;
  status: "pending" | "releasing" | "released" | "skipped" | "failed";
  releaseAt: Date;
  outcome?: string | null;
}

function holdLabel(p: HoldPayload): string {
  if (p.kind === "review_request") return "Review request";
  return p.message.source === "ai_reply" ? "AI reply" : "Missed-call text-back";
}

/**
 * Park `payload` until `hold.until` and schedule its release. Returns false
 * when the release could not be scheduled — the hold is then marked failed and
 * the contact's timeline says so, rather than promising a send that will never
 * come. Never throws.
 */
export async function holdForQuietHours(input: {
  agencyId: string;
  subAccountId: string;
  payload: HoldPayload;
  hold: QuietHoursHold;
}): Promise<boolean> {
  const { agencyId, subAccountId, payload, hold } = input;
  const contactId =
    payload.kind === "message" ? payload.message.contactId : payload.request.contactId;
  const db = getAdminDb();
  try {
    const ref = db.collection(`subAccounts/${subAccountId}/quietHoursHolds`).doc();
    const doc: HoldDoc = {
      agencyId,
      subAccountId,
      contactId,
      payload,
      status: "pending",
      releaseAt: hold.until,
      outcome: null,
    };
    await ref.set({ ...doc, createdAt: FieldValue.serverTimestamp() });
    const res = await publishCallback({
      pathname: QUIET_HOURS_RELEASE_PATH,
      body: { subAccountId, holdId: ref.id },
      delaySeconds: hold.retryAfterSec,
      deduplicationId: `qh_${ref.id}`,
    });
    const ok = res !== null;
    if (!ok) await ref.update({ status: "failed", outcome: "schedule_failed" });
    await writeHoldActivity(
      contactId,
      ok
        ? `${holdLabel(payload)} held for quiet hours; it goes out at ${hold.until.toISOString()}.`
        : `${holdLabel(payload)} held for quiet hours, but its release could not be scheduled, so it will NOT be sent.`,
    );
    return ok;
  } catch (err) {
    console.error("[quiet-hours] hold failed", err);
    await writeHoldActivity(
      contactId,
      `${holdLabel(payload)} fell in quiet hours and could not be held, so it was NOT sent.`,
    );
    return false;
  }
}

export async function writeHoldActivity(contactId: string, content: string): Promise<void> {
  try {
    await getAdminDb().collection(`contacts/${contactId}/activities`).add({
      type: "quiet_hours_held" satisfies ActivityType,
      content,
      createdBy: "quiet_hours",
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("[quiet-hours] activity write failed", err);
  }
}

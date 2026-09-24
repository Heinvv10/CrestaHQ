import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import { formatHoldUntil, type QuietHoursHold } from "@/lib/comms/quiet-hours";
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
  status: "pending" | "releasing" | "released" | "skipped" | "failed" | "superseded";
  releaseAt: Date;
  /** When it was held — a thread message after this makes a held AI reply stale. */
  heldAt: Date;
  outcome?: string | null;
}

function holdLabel(p: HoldPayload): string {
  if (p.kind === "review_request") return "Review request";
  return p.message.source === "ai_reply" ? "AI reply" : "Missed-call text-back";
}

/**
 * An AI reply answers the conversation as it stood. Five messages at 23:00
 * would otherwise park five replies that all go out at 08:00 together, each
 * answering a stale moment — so a new held AI reply supersedes the contact's
 * older pending ones (they never send). Single-field query, filtered here.
 */
async function supersedeOlderAiReplyHolds(subAccountId: string, contactId: string): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection(`subAccounts/${subAccountId}/quietHoursHolds`)
    .where("contactId", "==", contactId)
    .get();
  await Promise.all(
    snap.docs
      .filter((d) => {
        const h = d.data() as HoldDoc;
        return h.status === "pending" && h.payload?.kind === "message" && h.payload.message.source === "ai_reply";
      })
      .map((d) => d.ref.update({ status: "superseded", outcome: "newer_ai_reply" })),
  );
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
    if (payload.kind === "message" && payload.message.source === "ai_reply") {
      await supersedeOlderAiReplyHolds(subAccountId, contactId);
    }
    const ref = db.collection(`subAccounts/${subAccountId}/quietHoursHolds`).doc();
    const doc: HoldDoc = {
      agencyId,
      subAccountId,
      contactId,
      payload,
      status: "pending",
      releaseAt: hold.until,
      heldAt: new Date(),
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
        ? `${holdLabel(payload)} held for quiet hours; it goes out at ${formatHoldUntil(hold)}.`
        : `${holdLabel(payload)} held for quiet hours, but its release could not be scheduled, so it will NOT be sent.`,
      `qh_${ref.id}`,
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

/** One timeline row. With `id`, a retried write lands on the same row. */
export async function writeHoldActivity(contactId: string, content: string, id?: string): Promise<void> {
  try {
    const coll = getAdminDb().collection(`contacts/${contactId}/activities`);
    const row = {
      type: "quiet_hours_held" satisfies ActivityType,
      content,
      createdBy: "quiet_hours",
      createdAt: FieldValue.serverTimestamp(),
    };
    if (id) await coll.doc(id).set(row);
    else await coll.add(row);
  } catch (err) {
    console.warn("[quiet-hours] activity write failed", err);
  }
}

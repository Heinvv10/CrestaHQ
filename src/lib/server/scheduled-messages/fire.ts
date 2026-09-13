import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible } from "@/lib/comms/route-auth";
import { sendConversationMessage } from "@/lib/server/conversation-send";
import {
  LATE_DELIVERY_LIMIT_MS,
  LATE_DELIVERY_REASON,
  type ScheduledMessageChannel,
  type ScheduledMessageStatus,
} from "@/types/scheduled-messages";
import { scheduledMessagesPath, scheduledSendBlock } from "./service";

export type FireResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "sent"; messageId: string }
  /** Refused before anything went out. */
  | { outcome: "failed"; reason: string }
  /** Attempted; whether it reached the contact is unknown. */
  | { outcome: "unconfirmed"; reason: string };

interface ScheduledDoc {
  subAccountId: string;
  createdByUid: string;
  channel: ScheduledMessageChannel;
  body: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  sendAt: Timestamp;
  status: ScheduledMessageStatus;
}

/**
 * Fire one scheduled message (the QStash worker's body).
 *
 * Idempotent: the message is claimed pending → sending in a transaction, and
 * only the delivery that wins the claim sends. A redelivery, a cancelled or an
 * already-sent message is a no-op. Once claimed it is never retried.
 *
 * A delivery more than LATE_DELIVERY_LIMIT_MS after `sendAt` is recorded as
 * failed inside the same transaction and sends nothing: a message timed for
 * 3pm is not the same message at 6pm.
 *
 * Ruling 6: everything is re-evaluated now, not trusted from booking time —
 * the contact still exists and is still reachable by the person who booked
 * it, opt-outs, agency gates, channel readiness and the messaging windows.
 * All of that is the send service's own check list (the one the live routes
 * run), plus scheduledSendBlock. A WhatsApp free-form message whose window
 * has closed is refused by the dispatcher and recorded as failed — never
 * converted to a template.
 *
 * Outcomes are split by what is actually known. A refusal before any provider
 * call is "failed" (certainly not sent). A provider failure — a 502 from the
 * send service, a WhatsApp result the provider marked AMBIGUOUS, or a throw
 * mid-send — is "unconfirmed": a timeout can follow delivery, and calling it
 * "not sent" would invite the operator to send it twice.
 */
export async function fireScheduledMessage(
  contactId: string,
  id: string,
  nowMs: number = Date.now()
): Promise<FireResult> {
  const db = getAdminDb();
  const ref = db.doc(`${scheduledMessagesPath(contactId)}/${id}`);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const doc = snap.data() as ScheduledDoc;
    if (doc.status !== "pending") return doc.status;
    if (nowMs - (doc.sendAt?.toMillis?.() ?? nowMs) > LATE_DELIVERY_LIMIT_MS) {
      tx.update(ref, {
        status: "failed" satisfies ScheduledMessageStatus,
        failureReason: LATE_DELIVERY_REASON,
        failureCode: "delivered_late",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "late" as const;
    }
    tx.update(ref, {
      status: "sending" satisfies ScheduledMessageStatus,
      claimedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return doc;
  });
  if (claimed === null) return { outcome: "skipped", reason: "missing" };
  if (claimed === "late") return { outcome: "failed", reason: LATE_DELIVERY_REASON };
  if (typeof claimed === "string") return { outcome: "skipped", reason: `status:${claimed}` };
  const doc = claimed;

  const record = async (
    status: "failed" | "unconfirmed",
    reason: string,
    code: string | null = null
  ): Promise<FireResult> => {
    await ref.update({
      status: status satisfies ScheduledMessageStatus,
      failureReason: reason,
      failureCode: code,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { outcome: status, reason };
  };

  let contact;
  try {
    contact = await requireContactAccessible(doc.createdByUid, contactId);
  } catch (err) {
    console.error("[scheduled-messages/fire] contact re-check threw", err);
    return record("failed", "Couldn't re-check the contact before sending, so it was not sent.");
  }
  if (contact instanceof NextResponse) {
    return record(
      "failed",
      contact.status === 404
        ? "The contact no longer exists."
        : "The person who scheduled this message no longer has access to this contact."
    );
  }
  if (contact.subAccountId !== doc.subAccountId) {
    return record("failed", "The contact is no longer in this sub-account.");
  }
  const blocked = scheduledSendBlock(doc.channel, contact);
  if (blocked) return record("failed", blocked.error, blocked.code ?? null);

  const user = await getAdminAuth().getUser(doc.createdByUid).catch(() => null);

  let outcome;
  try {
    outcome = await sendConversationMessage({
      channel: doc.channel,
      contactId,
      contact,
      body: doc.body,
      subject: doc.subject ?? undefined,
      inReplyTo: doc.inReplyTo ?? undefined,
      references: doc.references ?? undefined,
      actor: { uid: doc.createdByUid, email: user?.email ?? "" },
      // Nobody is at the keyboard when this fires: the bridge keeps its full
      // quiet-hours guard, exactly like every other automated sender.
      humanReply: false,
      // Bridge rail: a redelivery converges on this send instead of repeating it.
      idempotencyKey: `scheduled_${id}`,
    });
  } catch (err) {
    console.error("[scheduled-messages/fire] send threw", err);
    return record(
      "unconfirmed",
      err instanceof Error ? err.message : "The send stopped with an error."
    );
  }

  if (!outcome.ok) {
    const unknown = outcome.status === 502 || outcome.outcomeUnknown === true;
    return record(unknown ? "unconfirmed" : "failed", outcome.error, outcome.code ?? null);
  }
  await ref.update({
    status: "sent" satisfies ScheduledMessageStatus,
    sentMessageId: outcome.messageId,
    sentAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { outcome: "sent", messageId: outcome.messageId };
}

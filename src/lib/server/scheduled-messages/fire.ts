import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible } from "@/lib/comms/route-auth";
import { sendConversationMessage } from "@/lib/server/conversation-send";
import type {
  ScheduledMessageChannel,
  ScheduledMessageStatus,
} from "@/types/scheduled-messages";
import { scheduledMessagesPath, scheduledSendBlock } from "./service";

export type FireResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "sent"; messageId: string }
  | { outcome: "failed"; reason: string };

interface ScheduledDoc {
  subAccountId: string;
  createdByUid: string;
  channel: ScheduledMessageChannel;
  body: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  status: ScheduledMessageStatus;
}

const UNKNOWN_OUTCOME =
  "The send stopped with an error, so it may or may not have gone out — check the thread before sending it again.";

/**
 * Fire one scheduled message (the QStash worker's body).
 *
 * Idempotent: the message is claimed pending → sending in a transaction, and
 * only the delivery that wins the claim sends. A redelivery, a cancelled or an
 * already-sent message is a no-op. Once claimed it is never retried — a send
 * whose outcome is unknown is recorded as failed with that said plainly,
 * rather than risking a second message to a real person.
 *
 * Ruling 6: everything is re-evaluated now, not trusted from booking time —
 * the contact still exists and is still reachable by the person who booked
 * it, opt-outs, agency gates, channel readiness and the messaging windows.
 * All of that is the send service's own check list (the one the live routes
 * run), plus scheduledSendBlock. A WhatsApp free-form message whose window
 * has closed is refused by the dispatcher and recorded as failed — never
 * converted to a template.
 */
export async function fireScheduledMessage(
  contactId: string,
  id: string
): Promise<FireResult> {
  const db = getAdminDb();
  const ref = db.doc(`${scheduledMessagesPath(contactId)}/${id}`);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const doc = snap.data() as ScheduledDoc;
    if (doc.status !== "pending") return doc.status;
    tx.update(ref, {
      status: "sending" satisfies ScheduledMessageStatus,
      claimedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return doc;
  });
  if (claimed === null) return { outcome: "skipped", reason: "missing" };
  if (typeof claimed === "string") return { outcome: "skipped", reason: `status:${claimed}` };
  const doc = claimed;

  const fail = async (reason: string, code: string | null = null): Promise<FireResult> => {
    await ref.update({
      status: "failed" satisfies ScheduledMessageStatus,
      failureReason: reason,
      failureCode: code,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { outcome: "failed", reason };
  };

  let contact;
  try {
    contact = await requireContactAccessible(doc.createdByUid, contactId);
  } catch (err) {
    console.error("[scheduled-messages/fire] contact re-check threw", err);
    return fail("Couldn't re-check the contact before sending, so it was not sent.");
  }
  if (contact instanceof NextResponse) {
    return fail(
      contact.status === 404
        ? "The contact no longer exists."
        : "The person who scheduled this message no longer has access to this contact."
    );
  }
  if (contact.subAccountId !== doc.subAccountId) {
    return fail("The contact is no longer in this sub-account.");
  }
  const blocked = scheduledSendBlock(doc.channel, contact);
  if (blocked) return fail(blocked.error, blocked.code ?? null);

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
    const detail = err instanceof Error ? ` (${err.message})` : "";
    return fail(`${UNKNOWN_OUTCOME}${detail}`);
  }

  if (!outcome.ok) return fail(outcome.error, outcome.code ?? null);
  await ref.update({
    status: "sent" satisfies ScheduledMessageStatus,
    sentMessageId: outcome.messageId,
    sentAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { outcome: "sent", messageId: outcome.messageId };
}

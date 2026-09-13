import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { precheckConversationMessage } from "@/lib/server/conversation-send";
import { refuse, type SendRefusal } from "@/lib/server/conversation-send/types";
import type { Contact } from "@/types/contacts";
import type {
  ScheduledMessageChannel,
  ScheduledMessageStatus,
  ScheduledMessageView,
} from "@/types/scheduled-messages";
import type { ScheduleRequest } from "./parse";

export const FIRE_PATH = "/api/scheduled-messages/fire";

export const scheduledMessagesPath = (contactId: string) =>
  `contacts/${contactId}/scheduledMessages`;

/**
 * Checks a scheduled send makes that the live route for its channel does not.
 *
 * The manual email route has never refused an opted-out contact server-side —
 * the composer disables itself instead. A scheduled message has no composer
 * at the moment it fires, so it gets the guard here, at booking and at fire
 * time. (The live route is left as it was: changing what it refuses is out of
 * scope for the extraction.)
 */
export function scheduledSendBlock(
  channel: ScheduledMessageChannel,
  contact: Contact
): SendRefusal | null {
  if (channel === "email" && contact.emailOptedOut) {
    return refuse(409, "This contact has opted out of email.");
  }
  return null;
}

/**
 * Book a message. The caller has already resolved the contact through
 * requireContactAccessible and matched it to the sub-account in the URL.
 * Runs the send-time checks now for early feedback; the worker runs them all
 * again when it fires.
 */
export async function scheduleConversationMessage(input: {
  request: ScheduleRequest;
  contact: Contact;
  actorUid: string;
  nowMs: number;
}): Promise<{ ok: true; id: string } | SendRefusal> {
  const { request, contact, actorUid } = input;
  const blocked =
    (await precheckConversationMessage(request.channel, contact)) ??
    scheduledSendBlock(request.channel, contact);
  if (blocked) return blocked;
  if (!qstashIsConfigured()) {
    return refuse(
      503,
      "Scheduling isn't available — QStash isn't configured on this deployment."
    );
  }

  const ref = getAdminDb().collection(scheduledMessagesPath(request.contactId)).doc();
  await ref.set({
    agencyId: contact.agencyId,
    subAccountId: contact.subAccountId,
    createdByUid: actorUid,
    contactId: request.contactId,
    channel: request.channel,
    body: request.body,
    subject: request.subject,
    inReplyTo: request.inReplyTo,
    references: request.references,
    sendAt: Timestamp.fromDate(request.sendAt),
    status: "pending" satisfies ScheduledMessageStatus,
    failureReason: null,
    failureCode: null,
    qstashMessageId: null,
    sentMessageId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Written first so the worker always finds the doc: the lead time is at
  // least a minute (parseScheduleRequest), the write takes milliseconds.
  const published = await publishCallback({
    pathname: FIRE_PATH,
    body: { contactId: request.contactId, scheduledMessageId: ref.id },
    delaySeconds: Math.ceil((request.sendAt.getTime() - input.nowMs) / 1000),
    deduplicationId: `scheduled_${ref.id}`,
  });
  if (!published) {
    // Nothing will fire it, so it must not sit there looking booked.
    await ref.update({
      status: "failed" satisfies ScheduledMessageStatus,
      failureReason:
        "The scheduler (QStash) did not accept this message, so it will not be sent.",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return refuse(502, "Couldn't schedule the message. Please try again.");
  }
  await ref.update({
    qstashMessageId: published.messageId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, id: ref.id };
}

/** Cancel a pending message. Anything else has already fired (or failed). */
export async function cancelScheduledMessage(input: {
  contactId: string;
  subAccountId: string;
  id: string;
  actorUid: string;
}): Promise<{ ok: true } | SendRefusal> {
  const db = getAdminDb();
  const ref = db.doc(`${scheduledMessagesPath(input.contactId)}/${input.id}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || data?.subAccountId !== input.subAccountId) {
      return refuse(404, "Scheduled message not found.");
    }
    if (data.status !== "pending") {
      return refuse(409, `This message is already ${String(data.status)}.`);
    }
    tx.update(ref, {
      status: "cancelled" satisfies ScheduledMessageStatus,
      cancelledByUid: input.actorUid,
      cancelledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true as const };
  });
}

const iso = (v: unknown): string | null =>
  v instanceof Timestamp ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : null;

/** A contact's scheduled messages, soonest first. */
export async function listScheduledMessages(
  contactId: string,
  subAccountId: string
): Promise<ScheduledMessageView[]> {
  const snap = await getAdminDb()
    .collection(scheduledMessagesPath(contactId))
    .orderBy("sendAt", "asc")
    .limit(100)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter(({ data }) => data.subAccountId === subAccountId)
    .map(({ id, data }) => ({
      id,
      contactId: String(data.contactId),
      channel: data.channel as ScheduledMessageChannel,
      body: String(data.body ?? ""),
      subject: (data.subject as string | null) ?? null,
      sendAt: iso(data.sendAt) ?? "",
      status: data.status as ScheduledMessageStatus,
      failureReason: (data.failureReason as string | null) ?? null,
      failureCode: (data.failureCode as string | null) ?? null,
      createdByUid: String(data.createdByUid ?? ""),
      createdAt: iso(data.createdAt),
    }));
}

import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { ActivityType } from "@/types/contacts";

/**
 * Timeline rows for events that reach a contact from outside the dashboard.
 * Writers never throw: every caller runs after the message row / task doc
 * is already committed, and a webhook that 500s over a derived timeline
 * entry reports a delivery failure for a message that in fact landed.
 */

export type InboundChannel =
  | "sms"
  | "whatsapp"
  | "email"
  | "messenger"
  | "instagram";

const RECEIVED_TYPE: Record<InboundChannel, ActivityType> = {
  sms: "sms_received",
  whatsapp: "whatsapp_received",
  email: "email_received",
  messenger: "messenger_received",
  instagram: "instagram_received",
};

const CHANNEL_LABEL: Record<InboundChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  email: "Email",
  messenger: "Messenger",
  instagram: "Instagram",
};

/** First 140 characters, single-line, with an ellipsis when cut. */
export function activityPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

export interface InboundMessageActivityInput {
  contactId: string;
  channel: InboundChannel;
  /** The message text; trimmed to a 140-char preview here. */
  preview: string;
  /** Id of the persisted message row (wamid / MessageSid / email id). */
  messageId: string | null;
  agencyId: string;
  subAccountId: string;
}

/**
 * `<channel>_received` row on the contact. Providers retry a webhook on any
 * non-2xx or timeout, and the message row survives that because it is keyed
 * by the provider id; the activity is keyed the same way so a retry is a
 * no-op here too. Only a message with no provider id gets an auto id.
 */
export async function writeInboundMessageActivity(
  db: FirebaseFirestore.Firestore,
  input: InboundMessageActivityInput
): Promise<void> {
  const preview = activityPreview(input.preview);
  try {
    const activities = db
      .collection("contacts")
      .doc(input.contactId)
      .collection("activities");
    const ref = input.messageId
      ? activities.doc(`inbound_${input.channel}_${input.messageId}`)
      : activities.doc();
    await ref.set(
      {
        type: RECEIVED_TYPE[input.channel],
        content: `${CHANNEL_LABEL[input.channel]} received: ${preview || "(no text)"}`,
        createdBy: `${input.channel}_inbound`,
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        meta: { channel: input.channel, messageId: input.messageId },
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("[contact-activities] inbound activity write failed", err);
  }
}

/** `task_created` row on the task's linked contact. */
export async function writeTaskCreatedActivity(
  db: FirebaseFirestore.Firestore,
  input: {
    contactId: string;
    taskId: string;
    title: string;
    dueAt: Date | null;
    createdByUid: string;
    agencyId: string;
    subAccountId: string;
  }
): Promise<void> {
  try {
    await db
      .collection("contacts")
      .doc(input.contactId)
      .collection("activities")
      .add({
        type: "task_created",
        content: `Task created: "${input.title}"`,
        createdBy: input.createdByUid,
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        meta: {
          taskId: input.taskId,
          dueAt: input.dueAt ? input.dueAt.toISOString() : null,
        },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(
      "[contact-activities] task_created activity write failed",
      err
    );
  }
}

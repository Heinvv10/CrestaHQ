import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendMetaMessage } from "@/lib/comms/meta";
import { metaCanInstagramDm } from "@/lib/comms/meta-capabilities";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { ActivityType, Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import {
  refuse,
  type ChannelSendBase,
  type Prepared,
  type SendOutcome,
  type SendRefusal,
} from "./types";

export type MetaChannel = "messenger" | "instagram";

const WINDOW_MS = 24 * 60 * 60 * 1000;

type MetaPrepared = Prepared<{
  recipientId: string;
  fromNodeId: string;
  pageAccessToken: string;
}>;

/**
 * Everything that can refuse a Messenger / Instagram DM before the window is
 * read (BETA channels):
 *   1. The contact must carry a `metaUserId` (they've messaged us) (400).
 *   2. Agency gate `metaInboxEnabledByAgency` must be on (403).
 *   3. The sub-account must have a connected Page — and, for Instagram, a
 *      linked IG account with the messaging scope (503 / 403).
 * Meta's 24-hour window is checked by the send, at the moment it goes out.
 */
export async function prepareMetaSend(
  contact: Contact,
  channel: MetaChannel
): Promise<MetaPrepared | SendRefusal> {
  if (!contact.metaUserId) {
    return refuse(400, "This contact hasn't messaged via Facebook/Instagram.");
  }

  const subAccountSnap = await getAdminDb()
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;

  if (subAccount?.metaInboxEnabledByAgency !== true) {
    return refuse(
      403,
      "The Facebook/Instagram inbox is disabled for this sub-account by your agency."
    );
  }

  const cfg = subAccount?.metaConfig ?? null;
  if (!cfg?.connected || !cfg.pageAccessToken) {
    return refuse(
      503,
      "No Facebook Page is connected. Connect one under Settings → Messaging."
    );
  }
  if (channel === "instagram" && !cfg.instagramBusinessAccountId) {
    return refuse(503, "No Instagram business account is linked to the connected Page.");
  }
  if (channel === "instagram" && !metaCanInstagramDm(cfg)) {
    return refuse(
      403,
      "Instagram messaging permission wasn't granted on this connection. Click Reconnect under Settings → Facebook & Instagram and approve Instagram access."
    );
  }
  // Meta's Messenger Platform sends BOTH channels from the Page node with the
  // Page token — the recipient's Instagram-scoped id is what routes an IG DM.
  // Posting to the IG business-account id instead fails with
  // "(#3) Application does not have the capability to make this API call".
  const fromNodeId = cfg.pageId;
  if (!fromNodeId) {
    return refuse(
      503,
      "The connected Page is missing its id — reconnect under Settings → Messaging."
    );
  }
  return {
    ok: true,
    recipientId: contact.metaUserId,
    fromNodeId,
    pageAccessToken: cfg.pageAccessToken,
  };
}

export async function sendConversationMeta(
  input: ChannelSendBase & { channel: MetaChannel }
): Promise<SendOutcome> {
  const { contactId, contact, body, actor, channel } = input;
  const prepared = await prepareMetaSend(contact, channel);
  if (!prepared.ok) return prepared;
  const { fromNodeId } = prepared;
  const db = getAdminDb();

  // 24-hour window guard. Find the most recent INBOUND on this channel; scan in
  // code over a single-field (auto-indexed) createdAt order so no composite
  // index is needed.
  const recent = await db
    .collection(`contacts/${contactId}/metaMessages`)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  let latestInboundMs: number | null = null;
  for (const d of recent.docs) {
    const m = d.data() as {
      direction?: string;
      channel?: string;
      createdAt?: Timestamp;
    };
    if (m.direction === "inbound" && m.channel === channel) {
      latestInboundMs = m.createdAt?.toDate?.().getTime() ?? null;
      break;
    }
  }
  if (latestInboundMs === null || Date.now() - latestInboundMs >= WINDOW_MS) {
    return refuse(
      409,
      "Meta's 24-hour messaging window is closed — the contact hasn't messaged within that time. Re-opening the conversation needs a message tag (coming in a later release).",
      "session_window_closed"
    );
  }

  let messageId: string;
  try {
    messageId = await sendMetaMessage({
      channel,
      fromNodeId,
      recipientId: prepared.recipientId,
      text: body,
      pageAccessToken: prepared.pageAccessToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message.";
    return refuse(502, message);
  }

  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  const label = channel === "instagram" ? "Instagram" : "Messenger";

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: (channel === "instagram"
          ? "instagram_sent"
          : "messenger_sent") satisfies ActivityType,
        content: `${label}: ${preview}`,
        createdBy: actor.uid,
        meta: { messageId },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[meta/send] activity write failed", err);
  }

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("metaMessages")
      .doc(messageId)
      .set({
        agencyId: contact.agencyId,
        subAccountId: contact.subAccountId,
        contactId,
        channel,
        direction: "outbound",
        status: "sent",
        body,
        from: fromNodeId,
        to: prepared.recipientId,
        metaMessageId: messageId,
        sentByUid: actor.uid,
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[meta/send] message-row write failed", err);
  }

  await upsertConversationForMessage({
    contactId,
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactName: contact.name ?? "",
    contactPhone: contact.phone || null,
    channel,
    direction: "outbound",
    body,
    pauseBot: true,
  });

  return { ok: true, messageId, response: { ok: true, messageId } };
}

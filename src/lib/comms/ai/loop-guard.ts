import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { PAUSE_WINDOW_MS } from "@/lib/server/conversations-service";

/**
 * Bot-to-bot reply-loop guard.
 *
 * A customer's own auto-responder (WhatsApp Business away message, an SMS
 * autoresponder) answers every AI reply, and the AI answers it back — forever,
 * until the token quota runs out, with a real handset buzzing throughout. No
 * single message looks wrong; only the rate does.
 *
 * So: at most AI_LOOP_MAX_REPLIES automated replies per conversation within
 * AI_LOOP_WINDOW_MS, counting only since the last HUMAN reply. Past that the
 * bot stops and pauses itself on the conversation, which the inbox already
 * shows as "Bot paused — Resume" for an operator to pick up.
 */
export const AI_LOOP_MAX_REPLIES = 5;
export const AI_LOOP_WINDOW_MS = 10 * 60 * 1000;

/** Rows scanned. A loop alternates in/out, so 5 AI replies sit well inside. */
const SCAN_LIMIT = 50;

/** True when this thread already carries the maximum AI replies in the window. */
export async function aiReplyLoopTripped(input: {
  contactId: string;
  messagesCollection: string;
  lastHumanReplyAtMs: number | null;
  nowMs?: number;
}): Promise<boolean> {
  const now = input.nowMs ?? Date.now();
  const since = Math.max(now - AI_LOOP_WINDOW_MS, input.lastHumanReplyAtMs ?? 0);
  const snap = await getAdminDb()
    .collection("contacts")
    .doc(input.contactId)
    .collection(input.messagesCollection)
    .orderBy("createdAt", "desc")
    .limit(SCAN_LIMIT)
    .get();
  let aiReplies = 0;
  for (const d of snap.docs) {
    const m = d.data() as {
      direction?: string;
      aiGenerated?: boolean;
      createdAt?: { toMillis?: () => number } | null;
    };
    const at =
      typeof m.createdAt?.toMillis === "function" ? m.createdAt.toMillis() : null;
    // Newest first, so the first row older than `since` ends the window.
    if (at !== null && at < since) break;
    if (m.direction === "outbound" && m.aiGenerated === true) aiReplies++;
  }
  return aiReplies >= AI_LOOP_MAX_REPLIES;
}

/**
 * Pause the bot on this conversation so a human picks it up. `update`, not a
 * merge-set: the inbound upsert has already created the doc with its tenancy
 * keys, and a merge-set on a missing doc would create one without them.
 */
export async function pauseBotForReplyLoop(conversationId: string): Promise<void> {
  try {
    await getAdminDb()
      .collection("conversations")
      .doc(conversationId)
      .update({ botPausedUntil: new Date(Date.now() + PAUSE_WINDOW_MS) });
  } catch (err) {
    console.warn("[ai/loop-guard] pause write failed", err);
  }
}

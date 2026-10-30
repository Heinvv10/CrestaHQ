import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import type { ConversationBotMode } from "@/types/conversations";

/**
 * Server-side write of a conversation's AI mode — the same field
 * the inbox sets through the client SDK (lib/firestore/conversations.ts,
 * within the rules' allowed key set). For API agents. Each re-checks the
 * sub-account inside its transaction; returns false when the conversation is
 * missing or belongs to another sub-account.
 */
async function patchConversation(
  conversationId: string,
  subAccountId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  if (!isDocId(conversationId)) return false;
  const db = getAdminDb();
  const ref = db.doc(`conversations/${conversationId}`);
  return db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (!current || current.subAccountId !== subAccountId) return false;
    tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export const setConversationBotModeServerSide = (
  conversationId: string,
  subAccountId: string,
  botMode: ConversationBotMode
) => patchConversation(conversationId, subAccountId, { botMode });

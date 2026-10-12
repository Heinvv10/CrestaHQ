import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ConversationDraft } from "@/types/conversations";

/*
 * The email send route's draft bookkeeping (PR #405 review A3/A4). Its own
 * module, not conversations-service: the send route must not pull in the
 * workflow engine just to clear a field.
 */

/**
 * Approve-time claim of an email draft: inside one transaction, take the
 * conversation's pendingDraft only if it is still the draft `draftId` names,
 * and clear it. Two approvals of one draft (two tabs) → one wins, the other
 * gets null; a draft replaced by a newer one → null. Throws on a Firestore
 * error (the caller refuses to send).
 */
export async function claimConversationDraft(
  contactId: string,
  draftId: string
): Promise<ConversationDraft | null> {
  const db = getAdminDb();
  const ref = db.doc(`conversations/${contactId}`);
  return db.runTransaction(async (tx) => {
    const draft = (await tx.get(ref)).data()?.pendingDraft as ConversationDraft | null | undefined;
    if (!draft || draft.id !== draftId) return null;
    tx.update(ref, { pendingDraft: null, updatedAt: FieldValue.serverTimestamp() });
    return draft;
  });
}

/** Put a claimed draft back after its send was refused before reaching the
 *  provider — unless something else has filled the slot meanwhile. */
export async function restoreConversationDraft(
  contactId: string,
  draft: ConversationDraft
): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`conversations/${contactId}`);
  try {
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).data()?.pendingDraft) return;
      tx.update(ref, { pendingDraft: draft, updatedAt: FieldValue.serverTimestamp() });
    });
  } catch (err) {
    console.warn(`[conversations/draft] restore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A person sent an email to this conversation: any pending draft is stale. */
export async function clearConversationDraft(contactId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`conversations/${contactId}`);
  try {
    await db.runTransaction(async (tx) => {
      if (!(await tx.get(ref)).data()?.pendingDraft) return;
      tx.update(ref, { pendingDraft: null, updatedAt: FieldValue.serverTimestamp() });
    });
  } catch (err) {
    console.warn(`[conversations/draft] clear failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

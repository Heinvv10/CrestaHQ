import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import type { SnippetInput } from "@/types/snippets";

/**
 * Snippet writes shared by the snippet routes and the agent capabilities.
 * `value` is already validated (validateSnippet). An agent's write is
 * stamped: a snippet is text a person may later send as their own.
 */

/** Null when the sub-account doesn't exist. */
export async function createSnippet(opts: {
  subAccountId: string;
  createdByUid: string;
  value: SnippetInput;
  actor?: AgentActor;
}): Promise<string | null> {
  const db = getAdminDb();
  const agencyId = (await db.doc(`subAccounts/${opts.subAccountId}`).get()).data()?.agencyId as string | undefined;
  if (!agencyId) return null;
  const ref = db.collection("snippets").doc();
  const now = FieldValue.serverTimestamp();
  await ref.set({
    ...opts.value,
    agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    createdAt: now,
    updatedAt: now,
    ...agentEditStamp(opts.actor),
  });
  return ref.id;
}

/** Replace a snippet's editable fields (the caller has checked its tenant). */
export async function updateSnippet(snippetId: string, value: SnippetInput, actor?: AgentActor): Promise<void> {
  await getAdminDb().doc(`snippets/${snippetId}`).update({
    ...value,
    updatedAt: FieldValue.serverTimestamp(),
    ...agentEditStamp(actor),
  });
}

import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { isAssignableMember } from "@/lib/server/assignee";
import { contactDisplayName } from "@/lib/contacts/display-name";

/** Longest note excerpt copied into a mention task's notes. */
const NOTE_EXCERPT = 500;
/** Upper bound on mentions read off one note — the field is client-written. */
const MAX_MENTIONS = 50;

/**
 * Turn an internal note's @mentions into tasks, one per mentioned member,
 * assigned to them. Shared by the human route (mention-tasks/route.ts, which
 * claims the note first) and the agent's add_conversation_note.
 *
 * Trusts only `rawMentionedUids`, each re-checked as an ACTIVE member of this
 * sub-account. The author is never tasked for mentioning themselves.
 * `authorName` is looked up from the author's member / user doc when absent.
 */
export async function createMentionTasks(input: {
  subAccountId: string;
  contactId: string;
  contact: FirebaseFirestore.DocumentData | undefined;
  content: string;
  rawMentionedUids: unknown;
  authorUid: string;
  authorName?: string;
  fallbackAgencyId?: string;
  fallbackEmail?: string;
}): Promise<string[]> {
  const { subAccountId, contactId, authorUid } = input;
  const raw = Array.isArray(input.rawMentionedUids) ? input.rawMentionedUids : [];
  const candidates = [
    ...new Set(raw.filter((u): u is string => typeof u === "string" && !!u)),
  ]
    .filter((uid) => uid !== authorUid)
    .slice(0, MAX_MENTIONS);
  const uids: string[] = [];
  for (const uid of candidates) {
    if (await isAssignableMember(subAccountId, uid)) uids.push(uid);
  }
  if (uids.length === 0) return [];

  const db = getAdminDb();
  const [subSnap, memberSnap, userSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    input.authorName
      ? undefined
      : db.doc(`subAccounts/${subAccountId}/subAccountMembers/${authorUid}`).get(),
    input.authorName ? undefined : db.doc(`users/${authorUid}`).get(),
  ]);
  const agencyId = (subSnap.data()?.agencyId as string) ?? input.fallbackAgencyId ?? "";
  const author =
    input.authorName ||
    (memberSnap?.data()?.displayName as string | undefined)?.trim() ||
    (userSnap?.data()?.displayName as string | undefined)?.trim() ||
    input.fallbackEmail ||
    "A teammate";
  const notes =
    input.content.length > NOTE_EXCERPT
      ? `${input.content.slice(0, NOTE_EXCERPT)}…`
      : input.content;
  const title = `Mentioned by ${author} in ${contactDisplayName(input.contact ?? {})}'s conversation`;

  const taskIds: string[] = [];
  for (const uid of uids) {
    const { id } = await createTaskServerSide({
      subAccountId,
      agencyId,
      createdByUid: authorUid,
      mode: "live",
      title,
      notes,
      dueAt: new Date(),
      contactId,
      dealId: null,
      eventId: null,
      assignedToUid: uid,
    });
    taskIds.push(id);
  }
  return taskIds;
}

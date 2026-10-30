import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createMentionTasks } from "@/lib/server/note-mention-tasks";

/**
 * POST — turn a conversation internal note's @mentions into tasks, one per
 * mentioned member, assigned to them (SP2 T2 mentions).
 *
 * Notes are written client-side, so this takes NOTHING from the request body:
 * it re-reads the note and trusts only its stored `mentionedUids`, each
 * re-checked as an ACTIVE member of this sub-account. Only the note's author
 * may call it, the author is never tasked for mentioning themselves, and the
 * note is claimed (`mentionTasksAt`) so a repeat call creates nothing.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; contactId: string; noteId: string }> }
) {
  const { id: subAccountId, contactId, noteId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  const contact = contactSnap.data();
  if (!contactSnap.exists || contact?.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const noteRef = db.doc(`contacts/${contactId}/notes/${noteId}`);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(noteRef);
    const note = snap.data();
    if (!snap.exists || !note) return { status: 404, error: "Note not found" } as const;
    if (note.createdBy !== access.uid) {
      return { status: 403, error: "Only the note's author can notify mentions" } as const;
    }
    if (note.mentionTasksAt) {
      return { status: 409, error: "Mention tasks were already created" } as const;
    }
    // Claimed BEFORE the tasks are created: a repeat call can never duplicate
    // them, at the cost that a createTaskServerSide failure mid-loop loses
    // the remaining tasks (no retry). Duplicates are the worse failure.
    tx.update(noteRef, { mentionTasksAt: FieldValue.serverTimestamp() });
    return { note };
  });
  if ("error" in claimed) {
    return NextResponse.json({ error: claimed.error }, { status: claimed.status });
  }

  const taskIds = await createMentionTasks({
    subAccountId,
    contactId,
    contact,
    content: String(claimed.note.content ?? ""),
    rawMentionedUids: claimed.note.mentionedUids,
    authorUid: access.uid,
    fallbackAgencyId: access.agencyId ?? undefined,
    fallbackEmail: access.email,
  });
  if (taskIds.length === 0) return NextResponse.json({ taskIds });
  return NextResponse.json({ taskIds }, { status: 201 });
}

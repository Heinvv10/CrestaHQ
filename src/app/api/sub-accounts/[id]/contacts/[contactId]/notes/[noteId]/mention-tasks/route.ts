import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { isAssignableMember } from "@/lib/server/assignee";
import { contactDisplayName } from "@/lib/contacts/display-name";

/** Longest note excerpt copied into a mention task's notes. */
const NOTE_EXCERPT = 500;
/** Upper bound on mentions read off one note — the field is client-written. */
const MAX_MENTIONS = 50;

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
    tx.update(noteRef, { mentionTasksAt: FieldValue.serverTimestamp() });
    return { note };
  });
  if ("error" in claimed) {
    return NextResponse.json({ error: claimed.error }, { status: claimed.status });
  }

  const raw = Array.isArray(claimed.note.mentionedUids) ? claimed.note.mentionedUids : [];
  const candidates = [
    ...new Set(raw.filter((u): u is string => typeof u === "string" && !!u)),
  ]
    .filter((uid) => uid !== access.uid)
    .slice(0, MAX_MENTIONS);
  const uids: string[] = [];
  for (const uid of candidates) {
    if (await isAssignableMember(subAccountId, uid)) uids.push(uid);
  }
  if (uids.length === 0) return NextResponse.json({ taskIds: [] });

  const [subSnap, memberSnap, userSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.doc(`subAccounts/${subAccountId}/subAccountMembers/${access.uid}`).get(),
    db.doc(`users/${access.uid}`).get(),
  ]);
  const agencyId = (subSnap.data()?.agencyId as string) ?? access.agencyId ?? "";
  const author =
    (memberSnap.data()?.displayName as string | undefined)?.trim() ||
    (userSnap.data()?.displayName as string | undefined)?.trim() ||
    access.email ||
    "A teammate";
  const content = String(claimed.note.content ?? "");
  const notes =
    content.length > NOTE_EXCERPT ? `${content.slice(0, NOTE_EXCERPT)}…` : content;
  const title = `Mentioned by ${author} in ${contactDisplayName(contact)}'s conversation`;

  const taskIds: string[] = [];
  for (const uid of uids) {
    const { id } = await createTaskServerSide({
      subAccountId,
      agencyId,
      createdByUid: access.uid,
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
  return NextResponse.json({ taskIds }, { status: 201 });
}

import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emitContactDeleted } from "@/lib/server/contacts-service";
import { isDocId } from "@/lib/server/doc-id";

/**
 * THE contact delete. Both the single DELETE /api/contacts/[id] route and
 * POST /api/contacts/bulk go through here, so every path refuses a contact
 * that other records still point at, sweeps its form submissions, deletes
 * its subcollections recursively and fires `contact.deleted` the same way.
 * Authorisation (admin of the sub-account) is the caller's job.
 */
export type DeleteContactResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "blocked"; blockers: ContactBlocker[] };

export async function deleteContactServerSide(opts: {
  contactId: string;
  /** When set, a contact in any other sub-account reads as not found. */
  subAccountId?: string;
}): Promise<DeleteContactResult> {
  if (!isDocId(opts.contactId)) return { status: "not_found" };
  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${opts.contactId}`);
  const snap = await contactRef.get();
  if (!snap.exists) return { status: "not_found" };
  const contact = snap.data()!;
  if (opts.subAccountId !== undefined && contact.subAccountId !== opts.subAccountId) {
    return { status: "not_found" };
  }
  const subAccountId = contact.subAccountId as string;
  const agencyId = contact.agencyId as string;

  // Refuse deletion while the contact is still linked to independent
  // business records (deals, quotes, bookings, …) — those never cascade;
  // the operator must clear/reassign them first.
  const { blockers, submissionRefs } = await findContactBlockers(
    db,
    subAccountId,
    opts.contactId,
  );
  if (blockers.length > 0) return { status: "blocked", blockers };

  // Sweep the contact's form submissions with it. A submission is the
  // inbound event that CREATED the contact — same category as the notes and
  // activities that already cascade — not an independent record worth
  // blocking on. Without this, a spam contact whose only link is a
  // live-form submission was undeletable (there's no per-submission delete
  // anywhere in the UI or API).
  for (let i = 0; i < submissionRefs.length; i += 500) {
    const batch = db.batch();
    for (const ref of submissionRefs.slice(i, i + 500)) {
      batch.delete(ref);
    }
    await batch.commit();
  }

  // Nothing references the contact — safe to delete it and its own
  // subcollections (notes, activities, messages).
  await db.recursiveDelete(contactRef);

  // Fire contact.deleted from the pre-delete snapshot — by the time
  // subscribers react the doc is gone, so we serialize what we just read.
  emitContactDeleted({
    subAccountId,
    agencyId,
    contactId: opts.contactId,
    data: contact,
  });
  return { status: "deleted" };
}

export interface ContactBlocker {
  type: string;
  /** Singular human label, e.g. "deal" → "2 deals". */
  label: string;
  count: number;
}

/**
 * Count every record that points at this contact across the resources a
 * delete must not orphan. Any non-zero count blocks the delete. Uses
 * count() aggregation so we never read the docs themselves.
 */
export async function findContactBlockers(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  contactId: string,
): Promise<{
  blockers: ContactBlocker[];
  /**
   * ALL of the contact's form submissions (live or dead form). Submissions
   * never block — they cascade: the DELETE handler sweeps them with the
   * contact, since a submission is just the inbound event that created it.
   */
  submissionRefs: FirebaseFirestore.DocumentReference[];
}> {
  const inSub = (collection: string) =>
    db
      .collection(collection)
      .where("subAccountId", "==", subAccountId)
      .where("contactId", "==", contactId)
      .count()
      .get();

  const [deals, tasks, events, quotes, submissionDocs, webChats, voiceCalls] =
    await Promise.all([
      inSub("deals"),
      inSub("tasks"),
      inSub("events"),
      inSub("quotes"),
      // Form submissions live in forms/{id}/submissions — a collection-group
      // query finds them across every form. contactId is a globally unique
      // doc id, so no sub-account filter is needed. Refs only (select()) —
      // these all get swept by the DELETE handler, never blocked on.
      db
        .collectionGroup("submissions")
        .where("contactId", "==", contactId)
        .select()
        .limit(1000)
        .get(),
      db
        .collection("subAccounts")
        .doc(subAccountId)
        .collection("webChatSessions")
        .where("contactId", "==", contactId)
        .count()
        .get(),
      db
        .collection("subAccounts")
        .doc(subAccountId)
        .collection("voiceCalls")
        .where("contactId", "==", contactId)
        .count()
        .get(),
    ]);

  const out: ContactBlocker[] = [];
  const add = (count: number, type: string, label: string) => {
    if (count > 0) out.push({ type, label, count });
  };
  add(deals.data().count, "deals", "deal");
  add(tasks.data().count, "tasks", "task");
  add(events.data().count, "events", "calendar event / booking");
  add(quotes.data().count, "quotes", "quote / invoice");
  add(webChats.data().count, "web_chat_sessions", "web-chat conversation");
  add(voiceCalls.data().count, "voice_calls", "voice call");
  return {
    blockers: out,
    submissionRefs: submissionDocs.docs.map((d) => d.ref),
  };
}

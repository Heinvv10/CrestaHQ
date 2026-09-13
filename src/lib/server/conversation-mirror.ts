import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * The conversation index mirrors two fields off its contact so the inbox can
 * filter and search without loading every contact:
 *
 *   `assigneeUid`  ← `contact.assignedToUid`  (SP2 T1, inbox scope I3)
 *   `contactEmail` ← `contact.email`          (SP2 I9, inbox search)
 *
 * **The contact is the source of truth.** `assigneeUid` is NOT client-writable
 * (see firestore.rules) — the only writers are this module and the two
 * conversation upserts, all server-side, so the mirror cannot diverge by a
 * client writing one side. There are no Firestore triggers in this repo, so
 * every path that changes `contact.assignedToUid` calls
 * `mirrorContactAssignee` in the same operation; every path that creates or
 * touches a conversation re-reads the contact and re-stamps the mirror, which
 * makes it self-healing on the next message either way.
 *
 * `contactEmail` follows the same staleness contract as the `contactName` /
 * `contactPhone` denormalizations that already live on the doc: refreshed by
 * the upserts, NOT re-written when the contact is edited.
 */

export {
  contactMirror,
  planConversationMirror,
  type ConversationMirror,
} from "@/lib/conversations/mirror-plan";

/**
 * Push a contact's new owner onto its conversation rows. Called by EVERY path
 * that changes `contact.assignedToUid` (the contact PATCH chokepoint
 * `updateContactServerSide` and the bulk-assign route) right after the contact
 * write lands.
 *
 * Best-effort by design: the contact is already saved and is the source of
 * truth, so a failed mirror must not 500 a save the operator can see
 * succeeded. A missed mirror self-heals on the conversation's next message,
 * and the backfill script repairs a whole sub-account on demand.
 *
 * Returns how many conversation rows were updated.
 */
export async function mirrorContactAssignee(opts: {
  contactId: string;
  subAccountId: string;
  assigneeUid: string | null;
}): Promise<number> {
  try {
    const db = getAdminDb();
    // Equality-only query — served by single-field indexes, no composite.
    const rows = await db
      .collection("conversations")
      .where("subAccountId", "==", opts.subAccountId)
      .where("contactId", "==", opts.contactId)
      .get();
    if (rows.empty) return 0;
    const batch = db.batch();
    for (const row of rows.docs) {
      batch.update(row.ref, {
        assigneeUid: opts.assigneeUid,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    return rows.size;
  } catch (err) {
    console.warn(
      "[conversation-mirror] assignee mirror failed",
      opts.contactId,
      err
    );
    return 0;
  }
}

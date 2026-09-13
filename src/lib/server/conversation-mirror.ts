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
 * the upserts (and alongside an owner change, since that mirror copies the
 * contact's current fields), not on an ordinary contact edit.
 */

import { contactMirror } from "@/lib/conversations/mirror-plan";

export {
  contactMirror,
  planConversationMirror,
  type ConversationMirror,
} from "@/lib/conversations/mirror-plan";

/**
 * Re-stamp a contact's owner + email onto its conversation rows. Called by
 * EVERY path that changes `contact.assignedToUid` (the contact PATCH
 * chokepoint `updateContactServerSide` and the bulk-assign route) right after
 * the contact write lands.
 *
 * It never takes the value from the request. It re-reads the contact's
 * CURRENT fields inside a transaction and writes those: two near-simultaneous
 * assigns can finish their mirrors in either order, and a value carried from
 * the request would let the older one land last and leave the conversation on
 * the loser's owner. Reading inside the transaction also means a contact write
 * racing the mirror makes the transaction retry rather than commit stale.
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
}): Promise<number> {
  try {
    const db = getAdminDb();
    const contactRef = db.doc(`contacts/${opts.contactId}`);
    // Equality-only query — served by single-field indexes, no composite.
    const rowsQuery = db
      .collection("conversations")
      .where("subAccountId", "==", opts.subAccountId)
      .where("contactId", "==", opts.contactId);
    return await db.runTransaction(async (tx) => {
      const contact = (await tx.get(contactRef)).data();
      // Gone, or not this tenant's: nothing authoritative to copy.
      if (!contact || contact.subAccountId !== opts.subAccountId) return 0;
      const rows = await tx.get(rowsQuery);
      const mirror = contactMirror(contact);
      for (const row of rows.docs) {
        tx.update(row.ref, {
          ...mirror,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return rows.size;
    });
  } catch (err) {
    console.warn(
      "[conversation-mirror] assignee mirror failed",
      opts.contactId,
      err
    );
    return 0;
  }
}

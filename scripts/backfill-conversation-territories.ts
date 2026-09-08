/** Run with Node 22: node --env-file=.env.local --experimental-strip-types scripts/backfill-conversation-territories.ts [--apply]
 * Dry-run by default. Reads current contact and conversation together; safe to rerun.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

export async function backfillConversationTerritories(
  db: Firestore,
  apply = false
) {
  const result = {
    scanned: 0,
    changed: 0,
    unchanged: 0,
    orphaned: 0,
    applied: apply,
  };
  let after: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db
      .collection("conversations")
      .orderBy(FieldPath.documentId())
      .limit(250);
    if (after) query = query.startAfter(after);
    const page = await query.get();
    for (const row of page.docs) {
      const status = await db.runTransaction(async (tx) => {
        const current = await tx.get(row.ref);
        if (!current.exists) return { changed: false, orphaned: false };
        const conversation = current.data()!;
        let territoryId: string | null = null;
        let orphaned = false;
        if (conversation.contactId === null && row.id.startsWith("web_")) {
          territoryId = "global";
        } else if (
          typeof conversation.contactId === "string" &&
          !conversation.contactId.includes("/")
        ) {
          const contact = (
            await tx.get(db.doc(`contacts/${conversation.contactId}`))
          ).data();
          if (
            contact &&
            contact.subAccountId === conversation.subAccountId &&
            contact.agencyId === conversation.agencyId
          )
            territoryId = contact.territoryId ?? null;
          else orphaned = true;
        } else orphaned = true;
        const changed = conversation.territoryId !== territoryId;
        if (changed && apply) tx.update(row.ref, { territoryId });
        return { changed, orphaned };
      });
      result.scanned++;
      if (status.changed) result.changed++;
      else result.unchanged++;
      if (status.orphaned) result.orphaned++;
    }
    if (page.docs.length < 250) break;
    after = page.docs[page.docs.length - 1];
  }
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  console.log(
    JSON.stringify(
      await backfillConversationTerritories(
        getFirestore(),
        process.argv.includes("--apply")
      )
    )
  );
}

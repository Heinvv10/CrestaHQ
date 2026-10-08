import { adminDb } from "./admin";
import { readEnv } from "./env";
import { deleteScoped } from "./guard";
import { reapStaleE2eEvents } from "./reap-events";

/**
 * Remove what runs left in the fixture sub-accounts. Everything goes through
 * deleteScoped, which re-reads each document and throws if it is not
 * fixture-scoped — so a query bug here cannot delete a client's data, it
 * fails the caller instead. Callers must run assertFixtureSubAccount on both
 * ids first.
 *
 * Marker contacts are deleted with the rest; seed.ts recreates them. Form
 * submissions are deliberately left: they carry no subAccountId of their own,
 * so deleteScoped has nothing to assert on, and this file uses no other
 * delete path.
 */

async function purge(collection: string, subAccountId: string): Promise<void> {
  const snap = await adminDb()
    .collection(collection)
    .where("subAccountId", "==", subAccountId)
    .get();
  for (const doc of snap.docs) {
    await deleteScoped(doc.ref);
  }
}

export async function purgeFixtureData(): Promise<void> {
  const env = readEnv();
  for (const subAccountId of [
    env.E2E_SUBACCOUNT_ID,
    env.E2E_SUBACCOUNT_ID_SECONDARY,
  ]) {
    await purge("workflowRuns", subAccountId);
    await purge("contacts", subAccountId);
    // Inbox index rows (doc id == contactId, or web_{sessionId}) — seeded by
    // inbox-filters.spec.ts; left behind, they would outlive their contacts.
    await purge("conversations", subAccountId);
    await purge("companies", subAccountId);
    await purge("snippets", subAccountId);
    // Prospecting mystery shops (mystery-shop-email.spec.ts) outlive their contacts otherwise.
    await purge("mysteryShops", subAccountId);
    // Stale ones only: events are not fully purged like the rows above, since
    // specs seed them per run and a concurrent run's may still be live.
    await reapStaleE2eEvents(subAccountId);
  }
}

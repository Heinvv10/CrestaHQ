import { adminDb } from "./lib/admin";
import { readEnv } from "./lib/env";
import { deleteScoped } from "./lib/guard";

/**
 * Remove what the run left in the fixture sub-accounts. Everything goes
 * through deleteScoped, which re-reads each document and throws if it is not
 * fixture-scoped — so a query bug here cannot delete a client's data, it
 * fails the teardown instead.
 *
 * Marker contacts are deleted with the rest; seed.ts recreates them on the
 * next run. Form submissions are deliberately left: they carry no
 * subAccountId of their own, so deleteScoped has nothing to assert on, and
 * this file uses no other delete path.
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

export default async function globalTeardown(): Promise<void> {
  const env = readEnv();
  for (const subAccountId of [
    env.E2E_SUBACCOUNT_ID,
    env.E2E_SUBACCOUNT_ID_SECONDARY,
  ]) {
    await purge("workflowRuns", subAccountId);
    await purge("contacts", subAccountId);
  }
}

import { adminDb } from "./lib/admin";
import {
  FIXTURE_PRIMARY_NAME,
  FIXTURE_SECONDARY_NAME,
  readEnv,
} from "./lib/env";
import { assertFixtureSubAccount, deleteScoped } from "./lib/guard";

/**
 * Remove what the run left in the fixture sub-accounts. Everything goes
 * through deleteScoped, which re-reads each document and throws if it is not
 * fixture-scoped — so a query bug here cannot delete a client's data, it
 * fails the teardown instead.
 *
 * Playwright runs this even when global setup THROWS, so setup's identity
 * checks do not fence these deletes — this file re-runs them itself before
 * touching anything. Without that, an E2E_SUBACCOUNT_ID pointing at a client
 * tenant would abort setup with "refusing to run" and then have its contacts
 * recursively deleted anyway.
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

  await assertFixtureSubAccount(env.E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(
    env.E2E_SUBACCOUNT_ID_SECONDARY,
    FIXTURE_SECONDARY_NAME,
  );

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
  }
}

import { adminDb } from "./admin";
import { readEnv } from "./env";

/**
 * Blast-radius guard.
 *
 * The suite runs against the real `crestahq-app` Firestore — there is no
 * staging project. Layer 0 of the fence is structural (the E2E identity owns
 * its own agency, so client tenants are unreachable through the app); this
 * module is the layer that catches a mistake made with the ADMIN sdk, which
 * has no tenancy at all.
 *
 * Every assertion THROWS. Nothing here warns, skips, or returns false — a
 * teardown that silently declines to delete a foreign document is
 * indistinguishable from one that deleted it.
 */

export function fixtureSubAccountIds(): [string, string] {
  const env = readEnv();
  return [env.E2E_SUBACCOUNT_ID, env.E2E_SUBACCOUNT_ID_SECONDARY];
}

/**
 * Throw unless `doc` is stamped with one of the two fixture sub-accounts.
 * `label` names the document in the failure so a red teardown says which
 * write was out of bounds.
 */
export function assertFixtureScope(label: string, doc: unknown): void {
  const value =
    doc && typeof doc === "object"
      ? (doc as Record<string, unknown>).subAccountId
      : undefined;

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${label}: refusing to touch a document with no subAccountId.`,
    );
  }
  const allowed = fixtureSubAccountIds();
  if (!allowed.includes(value)) {
    throw new Error(
      `${label}: subAccountId ${value} is not a fixture sub-account ` +
        `(${allowed.join(", ")}). Refusing to touch it.`,
    );
  }
}

/** Throw unless the named sub-account belongs to the fixture agency. */
export async function assertFixtureAgency(subAccountId: string): Promise<void> {
  const env = readEnv();
  const snap = await adminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    throw new Error(`Fixture sub-account ${subAccountId} does not exist.`);
  }
  const agencyId = snap.data()?.agencyId;
  if (agencyId !== env.E2E_AGENCY_ID) {
    throw new Error(
      `Fixture sub-account ${subAccountId} belongs to agency ${String(
        agencyId,
      )}, not ${env.E2E_AGENCY_ID}. Refusing to run.`,
    );
  }
}

/**
 * Fetch, assert, then delete — recursively, so a contact's notes and
 * activities go with it. The read is not an optimisation to skip: it is what
 * makes the assertion possible at all.
 */
export async function deleteScoped(
  ref: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const snap = await ref.get();
  if (!snap.exists) return;
  assertFixtureScope(ref.path, snap.data());
  await adminDb().recursiveDelete(ref);
}

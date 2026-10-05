import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { apiKeyRef } from "@/lib/firestore/api-keys";
import { CapabilityUserError, type ExecuteResult } from "@/lib/ai-suite/capabilities/types";
import { millis } from "@/lib/server/agent-proposals-encoding";
import { recordGateChanges } from "@/lib/server/feature-gates-service";
import { reserveAccountNumber, writeNewSubAccount } from "@/lib/server/sub-accounts-service";

/**
 * `create_sub_account` on an agency key (AGENCY_AGENT_API_PLAN.md D3): the
 * same writes as the app's create, plus both reach gates on (so the key can
 * act in what it made) and `createdByKeyId`. The member is the owner who
 * minted the key, never the key. Per key: at most KEY_CREATIONS_PER_DAY a UTC
 * day (a counter doc), and the same name within NAME_LOCK_MS returns the
 * sub-account already made (a lock doc) — both read in the creating
 * transaction, so concurrent calls cannot slip past either. No query, no index.
 */

export const KEY_CREATIONS_PER_DAY = 10;
export const NAME_LOCK_MS = 10 * 60 * 1000;
const REACH_GATES = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true } as const;

/** The name the lock is keyed by — NFKC, zero-width characters dropped,
 *  whitespace collapsed, lower case — so "Acme" and "acme  " are one name.
 *  The sub-account keeps the name as given. */
function lockName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function createSubAccountForAgencyKey(
  agencyId: string,
  keyId: string,
  args: Record<string, unknown>
): Promise<ExecuteResult> {
  const db = getAdminDb();
  const keyRef = apiKeyRef({ level: "agency", agencyId }, keyId);
  const name = args.name as string;
  const now = Date.now();
  const creations = keyRef.collection("creations");
  const dayRef = creations.doc(new Date(now).toISOString().slice(0, 10));
  const lockRef = creations.doc(`name_${createHash("sha256").update(lockName(name)).digest("hex")}`);
  const subRef = db.collection("subAccounts").doc();
  const made = await db.runTransaction(async (tx) => {
    // Auth checked both moments ago; a key revoked or an owner removed since
    // (committing before this transaction does) creates nothing.
    const key = (await tx.get(keyRef)).data();
    const minterUid = String(key?.createdByUid);
    const minter = (await tx.get(db.doc(`agencies/${agencyId}/agencyMembers/${minterUid}`))).data();
    if (!key || key.revokedAt || minter?.role !== "owner" || minter?.status !== "active") {
      throw new CapabilityUserError("This key can no longer create sub-accounts.");
    }
    const [day, lock] = await Promise.all([tx.get(dayRef), tx.get(lockRef)]);
    const held = lock.data();
    // A lock on a sub-account deleted since is no duplicate: create anew and move the lock.
    if (held && (millis(held.expiresAt) ?? 0) > now && (await tx.get(db.doc(`subAccounts/${String(held.subAccountId)}`))).exists) {
      return { created: false, subAccountId: held.subAccountId as string, accountNumber: held.accountNumber as number };
    }
    const count = (day.data()?.count as number | undefined) ?? 0;
    if (count >= KEY_CREATIONS_PER_DAY) {
      throw new CapabilityUserError(
        `This key has already created ${KEY_CREATIONS_PER_DAY} sub-accounts today (UTC). Try again tomorrow, or create it in the app.`
      );
    }
    const accountNumber = await reserveAccountNumber(tx, agencyId);
    const owner = { uid: minterUid, email: String(minter.email ?? ""), displayName: String(minter.displayName ?? "") };
    writeNewSubAccount(
      tx,
      subRef,
      accountNumber,
      { agencyId, ...owner, name, slug: (args.slug as string) ?? "", timezone: (args.timezone as string) ?? "UTC", accountContact: null },
      { ...REACH_GATES, createdByKeyId: keyId }
    );
    tx.set(dayRef, { count: count + 1 });
    tx.set(lockRef, { subAccountId: subRef.id, accountNumber, expiresAt: new Date(now + NAME_LOCK_MS) });
    return { created: true, subAccountId: subRef.id, accountNumber };
  });

  const ref = { kind: "subAccount", id: made.subAccountId };
  if (!made.created) {
    return {
      resultText: `This key created “${name}” (#${made.accountNumber}) under ten minutes ago; returning it instead of a duplicate.`,
      ref,
    };
  }
  // The doc did not exist before: both gates were off.
  await recordGateChanges(made.subAccountId, { type: "api_key", id: keyId }, {}, REACH_GATES);
  return {
    resultText: `Created sub-account “${name}” (#${made.accountNumber}), with API access and the Agent API on for this key.`,
    ref,
  };
}

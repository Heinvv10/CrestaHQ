import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { agentKeyRef } from "@/lib/firestore/api-keys";
import { STALE_CLAIM_MS, transitionIf } from "@/lib/server/agent-proposals";

/**
 * Sweeps over the agent approval queue: the key-revoke hook's and the daily
 * api-cleanup's. Every move is the same status-precondition transition the
 * decide route uses, so a sweep never clobbers a row another path moved. A
 * pending row's move also names the `rev` the sweep queried: a re-proposal
 * meanwhile can roll the row over to a fresh generation (createProposal),
 * which the sweep must leave alone.
 */

const SWEEP_LIMIT = 500;

/**
 * Revoking a key rejects its still-pending rows (never an executing one), in
 * every sub-account: an agency key's rows sit under each one it reached. A
 * row is the key's when `agentKeyRef(row)` is the revoked key's own doc.
 */
export async function sweepRevokedKeyProposals(input: {
  keyRef: FirebaseFirestore.DocumentReference;
}): Promise<number> {
  const snap = await getAdminDb()
    .collection("agentProposals")
    .where("keyId", "==", input.keyRef.id)
    .where("status", "==", "pending")
    .get();
  let rejected = 0;
  for (const doc of snap.docs) {
    if (agentKeyRef(doc.data()).path !== input.keyRef.path) continue;
    const moved = await transitionIf(
      doc.id,
      "pending",
      { status: "rejected", reason: "key_revoked", decidedAt: new Date() },
      { rev: doc.data().rev as string }
    );
    if (moved === "ok") rejected++;
  }
  return rejected;
}

/**
 * Daily (api-cleanup): expire `pending` rows past `expiresAt`, and flip
 * `executing` rows claimed over STALE_CLAIM_MS ago to `unsettled`.
 */
export async function sweepAgentProposals(
  now: Date
): Promise<{ collection: string; deleted: number; hitCap: boolean }> {
  const db = getAdminDb();
  const [expiring, stale] = await Promise.all([
    db.collection("agentProposals")
      .where("status", "==", "pending")
      .where("expiresAt", "<", now)
      .limit(SWEEP_LIMIT)
      .get(),
    db.collection("agentProposals")
      .where("status", "==", "executing")
      .where("claimedAt", "<", new Date(now.getTime() - STALE_CLAIM_MS))
      .limit(SWEEP_LIMIT)
      .get(),
  ]);
  let moved = 0;
  for (const doc of expiring.docs) {
    const rev = doc.data().rev as string;
    if ((await transitionIf(doc.id, "pending", { status: "expired", decidedAt: now }, { rev })) === "ok") {
      moved++;
    }
  }
  for (const doc of stale.docs) {
    const claimId = doc.data().claimId as string;
    if ((await transitionIf(doc.id, "executing", { status: "unsettled" }, { claimId })) === "ok") {
      moved++;
    }
  }
  return {
    collection: "agentProposals",
    deleted: moved,
    hitCap: expiring.size >= SWEEP_LIMIT || stale.size >= SWEEP_LIMIT,
  };
}

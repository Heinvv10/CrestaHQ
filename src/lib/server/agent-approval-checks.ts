import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { agentKeyRef } from "@/lib/firestore/api-keys";
import { agencyKeyStanding, type AgencyKeyStanding, type DocReader } from "@/lib/api/agency-key-standing";
import { canSeeTerritory } from "@/lib/ai-suite/territory-scope";
import type { EffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { millis } from "@/lib/server/agent-proposals-encoding";

/**
 * What approving an agent proposal checks, beyond its status and `rev`. The
 * decide route runs each check early, on the row it read; the claim
 * (`claimProposal`) runs them again on the row and docs it reads inside its
 * transaction, so nothing that changes in between can execute.
 */

/** Why a row may not be approved right now (beyond its own status). */
export type ApprovalRefusal =
  | "gate_off"
  | "wrong_agency"
  | "key_revoked"
  | Exclude<AgencyKeyStanding, "ok">;

/** Every refusal the claim can return besides `conflict` / `stale`. */
export type ClaimRefusal = ApprovalRefusal | "not_visible" | "expired";

/**
 * The same gate as firestore.rules' canSeeProposal: a scoped target (the
 * default when absent) needs the row's territoryId in the caller's `scope`.
 * `scope` is null when the caller's was never loaded (the row was
 * tenant-wide when read): a scoped row then fails closed.
 */
export function proposalVisible(
  row: FirebaseFirestore.DocumentData,
  scope: EffectiveTerritoryScope | null
): boolean {
  return row.targetScoped === false || (scope !== null && canSeeTerritory(scope, row.territoryId));
}

/** A `pending` row past its `expiresAt` can no longer be approved. */
export const pastExpiry = (row: FirebaseFirestore.DocumentData): boolean =>
  (millis(row.expiresAt) ?? Infinity) < Date.now();

/**
 * Everything approving a row needs of the world beyond the row: both of its
 * sub-account's Agent API gates on, an agency key's row in that sub-account's
 * own agency, the proposing key (`agentKeyRef`) still unrevoked, and an
 * agency key's standing (`agencyKeyStanding`). Plain reads for the decide
 * route's early refusal, `tx.get` inside the claim.
 */
export async function approvalRefusal(
  row: FirebaseFirestore.DocumentData,
  read: DocReader = (ref) => ref.get()
): Promise<ApprovalRefusal | null> {
  const sub = (await read(getAdminDb().doc(`subAccounts/${row.subAccountId}`))).data();
  if (sub?.agentApiEnabledByAgency !== true || sub?.apiAccessEnabledByAgency !== true) return "gate_off";
  // The key and standing reads below are keyed by an agency row's agencyId.
  if (row.keyLevel === "agency" && row.agencyId !== sub.agencyId) return "wrong_agency";
  const key = (await read(agentKeyRef(row))).data();
  if (!key || key.revokedAt) return "key_revoked";
  if (row.keyLevel !== "agency") return null;
  const standing = await agencyKeyStanding(row.agencyId as string, key.createdByUid, read);
  return standing === "ok" ? null : standing;
}

import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";

/** The ONE answer for a sub-account an agency key may not act in, whatever
 *  the cause (another agency's, a gate off, no such doc, not an id), so a
 *  key cannot probe which sub-accounts exist. */
export const NO_SUCH_SUB_ACCOUNT = "No such sub-account is available to this key.";

/** Whether an agency key of `agencyId` may act in this sub-account: its own
 *  agency's, with both the API-access and the Agent API gates switched on. */
export function isReachable(
  data: FirebaseFirestore.DocumentData | undefined,
  agencyId: string,
): boolean {
  return (
    data?.agencyId === agencyId &&
    data.apiAccessEnabledByAgency === true &&
    data.agentApiEnabledByAgency === true
  );
}

/**
 * The tenancy boundary for an agency key: the target `subAccountId` it sent,
 * read fresh, or null when it may not act there. Runs on every
 * `subAccountId` an agency key sends, before any capability code. An id
 * with surrounding whitespace is refused: capabilities read ids trimmed, so
 * the id checked here must already be the id they use.
 */
export async function resolveReach(agencyId: string, subAccountId: unknown): Promise<string | null> {
  if (!isDocId(subAccountId) || subAccountId !== subAccountId.trim()) return null;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return isReachable(snap.data(), agencyId) ? subAccountId : null;
}

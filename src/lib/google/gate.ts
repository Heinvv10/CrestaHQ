import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Agency gate for the Google Business Profile connection. Opt-in like every
 * gate: legacy/unset reads as off. The Manage-dialog checkbox flips
 * `googleEnabledByAgency` via /api/agency/sub-accounts/[id]/feature-gates.
 */
export async function googleGateOn(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.data()?.googleEnabledByAgency === true;
}

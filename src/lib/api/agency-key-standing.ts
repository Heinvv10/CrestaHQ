import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/** Why an agency key may not act right now, or "ok". */
export type AgencyKeyStanding = "ok" | "no_agency" | "agent_api_disabled" | "minter_removed";

/**
 * An agency key's standing, read fresh: its agency exists, the agency's
 * Agent API kill switch (`agencies/{id}.agentApiEnabled`, default off) is on,
 * and the owner who minted it (`createdByUid`) is still an active owner —
 * one read of their `agencyMembers` row, never the Auth Admin API. The ONE
 * check behind both the auth refusal and approving the key's proposals.
 */
export async function agencyKeyStanding(agencyId: string, createdByUid: unknown): Promise<AgencyKeyStanding> {
  const db = getAdminDb();
  const [agency, minter] = await Promise.all([
    db.doc(`agencies/${agencyId}`).get(),
    db.doc(`agencies/${agencyId}/agencyMembers/${String(createdByUid)}`).get(),
  ]);
  if (!agency.exists) return "no_agency";
  if (agency.data()?.agentApiEnabled !== true) return "agent_api_disabled";
  const member = minter.data();
  if (member?.role !== "owner" || member?.status !== "active") return "minter_removed";
  return "ok";
}

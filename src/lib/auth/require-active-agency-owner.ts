import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";

/**
 * 403 unless the caller's `agencyMembers` row is an ACTIVE owner; null when
 * it is. Claims outlive a removal until the token is re-minted, so the Agent
 * API key routes and switch re-read the row rather than trust the claim.
 */
export async function activeOwnerRefusal(
  uid: string,
  agencyId: string,
): Promise<NextResponse | null> {
  const row = (
    await getAdminDb().doc(`agencies/${agencyId}/agencyMembers/${uid}`).get()
  ).data();
  return row?.role === "owner" && row?.status === "active"
    ? null
    : NextResponse.json({ error: "Agency owner only" }, { status: 403 });
}

/** `requireAgencyOwnerAny`, plus the live `agencyMembers` row check. */
export async function requireActiveAgencyOwner(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  return (await activeOwnerRefusal(caller.uid, caller.agencyId!)) ?? caller;
}

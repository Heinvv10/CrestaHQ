import "server-only";

import { NextResponse } from "next/server";
import { requireActiveAgencyOwner } from "@/lib/auth/require-active-agency-owner";
import { getApiKey, revokeApiKey } from "@/lib/firestore/api-keys";
import { isDocId } from "@/lib/server/doc-id";
// Registers the revoke hook, so an agency key's proposals are swept once it
// can make any.
import "@/lib/server/agent-proposals-revoke-hook";

/**
 * Revoke an agency API key. Idempotent, like the sub-account route: an
 * already-revoked key answers 200. Auth: agency owner with an active
 * `agencyMembers` row, own agency only (the
 * key is looked up under the caller's agency, so another agency's id is 404).
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ keyId: string }> },
) {
  const caller = await requireActiveAgencyOwner(request);
  if (caller instanceof NextResponse) return caller;
  const { keyId } = await ctx.params;
  if (!isDocId(keyId)) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const owner = { level: "agency", agencyId: caller.agencyId! } as const;
  const doc = await getApiKey(owner, keyId);
  if (!doc) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  if (doc.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await revokeApiKey(owner, keyId, caller.uid);
  return NextResponse.json({ ok: true });
}

import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { revokeSnapshotShare } from "@/lib/snapshots/share";

/** DELETE — revoke a share link. The share doc stays, marked revoked. */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ snapshotId: string; shareId: string }> },
) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const { snapshotId, shareId } = await ctx.params;

  const revoked = await revokeSnapshotShare(getAdminDb(), {
    agencyId: caller.agencyId as string,
    snapshotId,
    shareId,
  });
  if (!revoked) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

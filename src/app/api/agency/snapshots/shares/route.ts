import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { listSnapshotShares } from "@/lib/snapshots/share";

/** GET — the caller agency's share links, with status. No token hashes. */
export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const shares = await listSnapshotShares(getAdminDb(), caller.agencyId as string);
  return NextResponse.json({ shares });
}

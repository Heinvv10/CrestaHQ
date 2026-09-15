import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { importSharedSnapshot } from "@/lib/snapshots/share";

/**
 * POST — import the snapshot behind another agency's share link into the
 * caller's agency. Link refusals are a uniform 404 (see importSharedSnapshot).
 */
export async function POST(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json({ error: "token is required." }, { status: 400 });
  }

  const outcome = await importSharedSnapshot(getAdminDb(), {
    token,
    agencyId: caller.agencyId as string,
    uid: caller.uid,
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  return NextResponse.json({ snapshotId: outcome.snapshotId });
}

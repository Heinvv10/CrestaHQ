import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { applySnapshot } from "@/lib/snapshots/apply";
import type { SnapshotPayload } from "@/types/snapshots";

interface ApplyBody {
  snapshotId?: string;
}

/**
 * Apply a stored snapshot's config into this sub-account. Agency-owner only.
 * The snapshot is loaded from the caller's own agency, so an owner can only
 * apply their agency's snapshots into their agency's sub-accounts.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: targetSubAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, targetSubAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner" || !access.agencyId) {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }
  const { agencyId, uid } = access;

  let body: ApplyBody;
  try {
    body = (await request.json()) as ApplyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const snapshotId = body.snapshotId?.trim();
  if (!snapshotId) {
    return NextResponse.json(
      { error: "snapshotId is required." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const snapSnap = await db
    .doc(`agencies/${agencyId}/snapshots/${snapshotId}`)
    .get();
  if (!snapSnap.exists) {
    return NextResponse.json({ error: "Snapshot not found." }, { status: 404 });
  }
  const payload = (snapSnap.data()?.payload ?? {}) as Partial<SnapshotPayload>;

  const result = await applySnapshot(
    db,
    {
      forms: payload.forms ?? [],
      messageTemplates: payload.messageTemplates ?? [],
      products: payload.products ?? [],
      workflows: payload.workflows ?? [],
    },
    targetSubAccountId,
    { agencyId, createdByUid: uid },
  );

  return NextResponse.json({ result });
}

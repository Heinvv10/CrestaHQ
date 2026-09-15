import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { createSnapshotShare, isShareExpiryDays } from "@/lib/snapshots/share";

interface ShareBody {
  expiresInDays?: unknown;
  singleUse?: unknown;
}

/**
 * POST — mint a share link for one of the caller's snapshots. The raw token
 * appears in this response's `url` and is never stored or returned again.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ snapshotId: string }> },
) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const agencyId = caller.agencyId as string;
  const { snapshotId } = await ctx.params;

  let body: ShareBody;
  try {
    body = (await request.json()) as ShareBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const expiresInDays = body.expiresInDays ?? 7;
  if (!isShareExpiryDays(expiresInDays)) {
    return NextResponse.json(
      { error: "expiresInDays must be 1, 7 or 30." },
      { status: 400 },
    );
  }

  // Check before writing: a share whose link cannot be built is a dead doc.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL isn't configured — can't build the link." },
      { status: 500 },
    );
  }

  const created = await createSnapshotShare(getAdminDb(), {
    agencyId,
    snapshotId,
    uid: caller.uid,
    expiresInDays,
    singleUse: body.singleUse === true,
  });
  if (created === "not_found") {
    return NextResponse.json({ error: "Snapshot not found." }, { status: 404 });
  }
  if (created === "imported") {
    return NextResponse.json(
      { error: "An imported snapshot can't be shared on." },
      { status: 409 },
    );
  }

  const url = `${base}/agency/snapshots/import?token=${encodeURIComponent(created.token)}`;
  return NextResponse.json({ share: created.share, url });
}

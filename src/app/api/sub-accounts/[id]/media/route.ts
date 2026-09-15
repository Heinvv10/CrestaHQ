import "server-only";

import { NextResponse } from "next/server";
import { withMedia } from "@/lib/media/route-support";
import { createMediaAsset } from "@/lib/media/service";

/**
 * POST /api/sub-accounts/[id]/media — register an object the browser has
 * already uploaded to `media/{id}/{mediaId}/…`. Body: `{ mediaId, name,
 * storagePath, downloadUrl, folderId }`; size/contentType are read from the
 * bucket, never from the body. Reads happen client-side over Firestore.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withMedia(request, id, async ({ subAccountId, agencyId, uid, body }) => {
    const asset = await createMediaAsset({ subAccountId, agencyId, uid, body });
    return NextResponse.json({ ok: true, asset });
  });
}

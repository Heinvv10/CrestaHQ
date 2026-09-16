import "server-only";

import { NextResponse } from "next/server";
import { withMedia } from "@/lib/media/route-support";
import { deleteMediaAsset, updateMediaAsset } from "@/lib/media/service";

/**
 * PATCH  — `{ name }` renames, `{ folderId }` moves (null = root).
 * DELETE — removes the bucket object, then the doc.
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; mediaId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const { id, mediaId } = await ctx.params;
  return withMedia(request, id, async ({ subAccountId, body }) => {
    await updateMediaAsset(subAccountId, mediaId, body);
    return NextResponse.json({ ok: true, id: mediaId });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id, mediaId } = await ctx.params;
  return withMedia(request, id, async ({ subAccountId }) => {
    await deleteMediaAsset(subAccountId, mediaId);
    return NextResponse.json({ ok: true, id: mediaId });
  });
}

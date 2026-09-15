import "server-only";

import { NextResponse } from "next/server";
import { withMedia } from "@/lib/media/route-support";
import { deleteMediaFolder, updateMediaFolder } from "@/lib/media/service";

/**
 * PATCH  — `{ name }` renames, `{ parentId }` moves (never into itself).
 * DELETE — refused with 409 while the folder holds files or sub-folders.
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; folderId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const { id, folderId } = await ctx.params;
  return withMedia(request, id, async ({ subAccountId, body }) => {
    await updateMediaFolder(subAccountId, folderId, body);
    return NextResponse.json({ ok: true, id: folderId });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id, folderId } = await ctx.params;
  return withMedia(request, id, async ({ subAccountId }) => {
    await deleteMediaFolder(subAccountId, folderId);
    return NextResponse.json({ ok: true, id: folderId });
  });
}

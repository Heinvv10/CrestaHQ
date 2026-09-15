import "server-only";

import { NextResponse } from "next/server";
import { withMedia } from "@/lib/media/route-support";
import { createMediaFolder } from "@/lib/media/service";

/** POST — create a folder: `{ name, parentId }` (parentId null = root). */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withMedia(request, id, async ({ subAccountId, agencyId, uid, body }) => {
    const folderId = await createMediaFolder({ subAccountId, agencyId, uid, body });
    return NextResponse.json({ ok: true, id: folderId });
  });
}

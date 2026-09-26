import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { deleteFolder, updateFolder } from "@/lib/custom-fields/folder-write";

/**
 * Per-folder operations. Sub-account admin only.
 *
 * PATCH  — rename and/or reorder. `entity` is immutable.
 * DELETE — remove the folder; its fields move back to General (`folderId:
 *          null`) in the same batch so no field is ever orphaned.
 */

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; folderId: string }> }
) {
  const { id: subAccountId, folderId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const done = await updateFolder({ subAccountId, folderId, body: b });
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ ok: true, id: folderId });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; folderId: string }> }
) {
  const { id: subAccountId, folderId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const done = await deleteFolder(subAccountId, folderId);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({
    ok: true,
    id: folderId,
    movedFields: done.movedFields,
  });
}

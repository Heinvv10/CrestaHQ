import "server-only";

import { NextResponse } from "next/server";
import { reorderFolders } from "@/lib/custom-fields/folder-write";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * PUT — set the display order of one entity's folders in a single batch.
 * Body: `{ entity, ids }` — every folder of that entity, in the wanted
 * order. Each is renumbered `order = index`, so the stored values are dense
 * by construction and a later move can never be scrambled by a gap left by
 * a delete. Sub-account admin only.
 */
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const done = await reorderFolders(subAccountId, body.entity, body.ids);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ ok: true, count: done.count });
}

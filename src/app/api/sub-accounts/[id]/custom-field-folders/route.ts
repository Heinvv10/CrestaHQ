import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { createFolder } from "@/lib/custom-fields/folder-write";

/**
 * Custom-field folders per sub-account (sibling of ../custom-fields).
 * Reads happen client-side over Firestore (member read rule); there is no
 * GET here.
 *
 * POST — create a folder. Sub-account admin only. Appended last in order.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
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
  const created = await createFolder({ subAccountId, createdByUid: access.uid, name: body.name, entity: body.entity });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });
  return NextResponse.json({ ok: true, id: created.id });
}

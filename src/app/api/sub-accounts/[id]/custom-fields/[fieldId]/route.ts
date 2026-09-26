import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { updateCustomField } from "@/lib/custom-fields/write";

/**
 * Per-definition operations. Sub-account admin only.
 *
 * PATCH  — edit the label, options, required flag, order, or folder (`folderId`:
 *          a folder of the same entity, or null for General). `entity`, `key`,
 *          and `type` are IMMUTABLE — changing them would orphan or corrupt
 *          stored values keyed by `key` and typed by `type`. To change a
 *          field's type, delete it and create a new one.
 * DELETE — remove the definition. Existing values on contacts/deals are left
 *          in place (harmless orphaned map keys); they simply stop rendering.
 */

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; fieldId: string }> },
) {
  const { id: subAccountId, fieldId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const done = await updateCustomField({
    subAccountId,
    fieldId,
    body: (body ?? {}) as Record<string, unknown>,
  });
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ ok: true, id: fieldId });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; fieldId: string }> },
) {
  const { id: subAccountId, fieldId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/customFields/${fieldId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Custom field not found" }, { status: 404 });
  }
  await ref.delete();
  return NextResponse.json({ ok: true, id: fieldId });
}

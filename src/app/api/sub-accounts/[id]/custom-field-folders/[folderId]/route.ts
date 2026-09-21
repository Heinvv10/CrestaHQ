import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { validateFolderName } from "@/lib/custom-fields/folders";

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

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/customFieldFolders/${folderId}`
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (b.name !== undefined) {
    const name = validateFolderName(b.name);
    if (!name) {
      return NextResponse.json(
        { error: "Folder name must be 1–60 characters." },
        { status: 400 }
      );
    }
    update.name = name;
  }
  if (b.order !== undefined) {
    const order = Number(b.order);
    if (!Number.isFinite(order)) {
      return NextResponse.json(
        { error: "Order must be a number." },
        { status: 400 }
      );
    }
    update.order = Math.max(0, Math.floor(order));
  }

  await ref.update(update);
  return NextResponse.json({ ok: true, id: folderId });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; folderId: string }> }
) {
  const { id: subAccountId, folderId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/customFieldFolders/${folderId}`
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const fields = await db
    .collection(`subAccounts/${subAccountId}/customFields`)
    .where("folderId", "==", folderId)
    .get();
  const batch = db.batch();
  for (const f of fields.docs) {
    batch.update(f.ref, {
      folderId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  batch.delete(ref);
  await batch.commit();
  return NextResponse.json({
    ok: true,
    id: folderId,
    movedFields: fields.size,
  });
}

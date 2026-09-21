import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { validateFolderName } from "@/lib/custom-fields/folders";
import { isFolderId } from "@/lib/workflows/folders";

/**
 * Per-folder operations. Member access, like the workflows they organise.
 *
 * PATCH  — rename.
 * DELETE — remove the folder; its workflows become Unfiled (`folderId:
 *          null`) in the same atomic write. A workflow is never deleted.
 */

const notFound = () =>
  NextResponse.json({ error: "Folder not found" }, { status: 404 });

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; folderId: string }> },
) {
  const { id: subAccountId, folderId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!isFolderId(folderId)) return notFound();

  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = validateFolderName(b.name);
  if (!name) {
    return NextResponse.json(
      { error: "Folder name must be 1–60 characters." },
      { status: 400 },
    );
  }

  const ref = getAdminDb().doc(
    `subAccounts/${subAccountId}/workflowFolders/${folderId}`,
  );
  if (!(await ref.get()).exists) return notFound();
  await ref.update({ name, updatedAt: FieldValue.serverTimestamp() });
  return NextResponse.json({ ok: true, id: folderId });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; folderId: string }> },
) {
  const { id: subAccountId, folderId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!isFolderId(folderId)) return notFound();

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/workflowFolders/${folderId}`);
  // A transaction rather than a batch: the folder read and the workflow
  // query are part of the same atomic unit, so the folder is never gone
  // while a workflow still points at it.
  const moved = await db.runTransaction(async (tx) => {
    const folder = await tx.get(ref);
    if (!folder.exists) return null;
    const workflows = await tx.get(
      db
        .collection("workflows")
        .where("subAccountId", "==", subAccountId)
        .where("folderId", "==", folderId),
    );
    for (const w of workflows.docs) tx.update(w.ref, { folderId: null });
    tx.delete(ref);
    return workflows.size;
  });
  if (moved === null) return notFound();
  return NextResponse.json({ ok: true, id: folderId, movedWorkflows: moved });
}

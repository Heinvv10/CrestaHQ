import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { validateFolderName } from "@/lib/custom-fields/folders";
import { MAX_WORKFLOW_FOLDERS } from "@/lib/workflows/folders";
import type { WorkflowFolder } from "@/types/workflows";

/**
 * Workflow folders per sub-account. Member access, like the workflows they
 * organise (../workflows).
 *
 * GET  — this sub-account's folders, by `order`.
 * POST — create a folder, appended last.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/workflowFolders`)
    .get();
  const folders = snap.docs
    .map((d) => ({ ...(d.data() as Omit<WorkflowFolder, "id">), id: d.id }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return NextResponse.json({ folders });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = validateFolderName(body.name);
  if (!name) {
    return NextResponse.json(
      { error: "Folder name must be 1–60 characters." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? null;
  if (!subSnap.exists || !agencyId) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }

  const col = db.collection(`subAccounts/${subAccountId}/workflowFolders`);
  const existing = await col.get();
  if (existing.size >= MAX_WORKFLOW_FOLDERS) {
    return NextResponse.json(
      { error: `At most ${MAX_WORKFLOW_FOLDERS} workflow folders.` },
      { status: 400 },
    );
  }
  const order =
    existing.docs.reduce(
      (max, d) => Math.max(max, (d.data().order as number) ?? 0),
      -1,
    ) + 1;

  const ref = col.doc();
  const now = FieldValue.serverTimestamp();
  const payload: Omit<WorkflowFolder, "id"> = {
    name,
    order,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(payload);
  return NextResponse.json({ ok: true, id: ref.id });
}

import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import {
  MAX_FOLDERS_PER_ENTITY,
  validateFolderName,
} from "@/lib/custom-fields/folders";
import type { CustomFieldFolder } from "@/types/custom-fields";

/**
 * Custom-field folders per sub-account (sibling of ../custom-fields).
 *
 * GET  — list folders (optionally `?entity=contact|deal`). Member-readable.
 * POST — create a folder. Sub-account admin only. Appended last in order.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const entity = new URL(request.url).searchParams.get("entity");
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/customFieldFolders`)
    .get();
  let folders = snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<CustomFieldFolder, "id">),
  }));
  if (entity === "contact" || entity === "deal") {
    folders = folders.filter((f) => f.entity === entity);
  }
  folders.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return NextResponse.json({ ok: true, folders });
}

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
  const name = validateFolderName(body.name);
  if (!name) {
    return NextResponse.json(
      { error: "Folder name must be 1–60 characters." },
      { status: 400 }
    );
  }
  const entity = body.entity;
  if (entity !== "contact" && entity !== "deal") {
    return NextResponse.json(
      { error: "Entity must be contact or deal." },
      { status: 400 }
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? null;
  if (!subSnap.exists || !agencyId) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 }
    );
  }

  const existing = await db
    .collection(`subAccounts/${subAccountId}/customFieldFolders`)
    .where("entity", "==", entity)
    .get();
  if (existing.size >= MAX_FOLDERS_PER_ENTITY) {
    return NextResponse.json(
      { error: `At most ${MAX_FOLDERS_PER_ENTITY} folders per ${entity}.` },
      { status: 400 }
    );
  }
  const nextOrder =
    existing.docs.reduce(
      (max, d) => Math.max(max, (d.data().order as number) ?? 0),
      -1
    ) + 1;

  const ref = db
    .collection(`subAccounts/${subAccountId}/customFieldFolders`)
    .doc();
  const now = FieldValue.serverTimestamp();
  const payload: Omit<CustomFieldFolder, "id"> = {
    name,
    entity,
    order: nextOrder,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(payload);
  return NextResponse.json({ ok: true, id: ref.id });
}

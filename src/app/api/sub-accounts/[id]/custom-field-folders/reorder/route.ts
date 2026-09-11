import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
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
  const entity = body.entity;
  if (entity !== "contact" && entity !== "deal") {
    return NextResponse.json(
      { error: "Entity must be contact or deal." },
      { status: 400 },
    );
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : null;
  if (!ids || new Set(ids).size !== ids.length) {
    return NextResponse.json(
      { error: "ids must be a list of distinct folder ids." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const existing = await db
    .collection(`subAccounts/${subAccountId}/customFieldFolders`)
    .where("entity", "==", entity)
    .get();
  const known = new Set(existing.docs.map((d) => d.id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    return NextResponse.json(
      { error: "ids must list every folder of this entity exactly once." },
      { status: 409 },
    );
  }

  const batch = db.batch();
  ids.forEach((id, index) => {
    batch.update(
      db.doc(`subAccounts/${subAccountId}/customFieldFolders/${id}`),
      { order: index, updatedAt: FieldValue.serverTimestamp() },
    );
  });
  await batch.commit();
  return NextResponse.json({ ok: true, count: ids.length });
}

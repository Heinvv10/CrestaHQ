import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { validateSnippet } from "@/lib/snippets/validate";
import { snippetToDto } from "@/lib/snippets/to-dto";

/**
 * Snippets (SP2 T3) — top-level `snippets/{id}`, scoped by `subAccountId`.
 * Every read and write goes through these Admin-SDK routes (the collection is
 * closed to clients in firestore.rules), so validation here is the only
 * validation and cannot be skipped. Any active member may manage them: a
 * snippet is reply content, not customer data (same stance as smart lists).
 *
 * GET  — the sub-account's snippets, newest-updated first.
 * POST — create one. Tenant keys come from the route + caller, never the body.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  // Single equality clause: no composite index. Sorted here instead.
  const snap = await getAdminDb()
    .collection("snippets")
    .where("subAccountId", "==", subAccountId)
    .get();
  const snippets = snap.docs
    .map((d) => snippetToDto(d.id, d.data()))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return NextResponse.json({ snippets });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = validateSnippet(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const db = getAdminDb();
  const agencyId = (await db.doc(`subAccounts/${subAccountId}`).get()).data()
    ?.agencyId as string | undefined;
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 }
    );
  }

  const ref = db.collection("snippets").doc();
  const now = FieldValue.serverTimestamp();
  await ref.set({
    ...v.value,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    createdAt: now,
    updatedAt: now,
  });
  return NextResponse.json({ ok: true, id: ref.id });
}

import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { validateSnippet } from "@/lib/snippets/validate";

/**
 * One snippet. PATCH replaces the editable fields (the editor always sends
 * the whole snippet); DELETE removes it. Both refuse a snippet that belongs
 * to another sub-account with the same 404 as a missing one — the route's
 * `[id]` is what the caller was authorised for, so the doc must match it.
 */

type Ctx = { params: Promise<{ id: string; snippetId: string }> };

async function load(request: Request, ctx: Ctx) {
  const { id: subAccountId, snippetId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const ref = getAdminDb().doc(`snippets/${snippetId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Snippet not found" }, { status: 404 });
  }
  return { ref, snippetId };
}

export async function PATCH(request: Request, ctx: Ctx) {
  const found = await load(request, ctx);
  if (found instanceof NextResponse) return found;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = validateSnippet(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  await found.ref.update({
    ...v.value,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true, id: found.snippetId });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const found = await load(request, ctx);
  if (found instanceof NextResponse) return found;
  await found.ref.delete();
  return NextResponse.json({ ok: true, id: found.snippetId });
}

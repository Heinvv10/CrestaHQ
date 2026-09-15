import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { parseTemplateMeta } from "@/lib/templates/validate";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The doc path is built from the CALLER's agency, never from the body, so a
 * template id from another agency resolves to nothing here.
 */
async function ownedRef(request: Request, ctx: Ctx) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const { id } = await ctx.params;
  const ref = getAdminDb().doc(`agencies/${caller.agencyId}/templates/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }
  return ref;
}

/** PATCH — rename / re-describe / re-tag. The payload is immutable. */
export async function PATCH(request: Request, ctx: Ctx) {
  const ref = await ownedRef(request, ctx);
  if (ref instanceof NextResponse) return ref;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseTemplateMeta(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (Object.keys(parsed.meta).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  await ref.update({ ...parsed.meta, updatedAt: FieldValue.serverTimestamp() });
  return NextResponse.json({ ok: true });
}

/** DELETE — remove from the library. Pushed copies are untouched. */
export async function DELETE(request: Request, ctx: Ctx) {
  const ref = await ownedRef(request, ctx);
  if (ref instanceof NextResponse) return ref;
  await ref.delete();
  return NextResponse.json({ ok: true });
}

import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";

/**
 * Delete a form AND its submissions subcollection.
 *
 * Why a server route: the dashboard used to delete forms with a client-SDK
 * `deleteDoc`, which cannot touch subcollections — `forms/{id}/submissions/*`
 * survived the parent. Those orphaned submissions stay indexed by contactId
 * and block contact deletion with no UI that can ever clear them.
 * `recursiveDelete` (Admin SDK) wipes the form and its submissions together.
 *
 * Auth: any active member of the form's sub-account — parity with the
 * client-SDK delete this replaces. Note `/api/forms` is a middleware
 * PUBLIC_PATH (for the unauthenticated submit endpoint), so this route
 * enforces auth itself; a session-less caller has no x-user-uid and 401s.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const ref = db.doc(`forms/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Form not found" }, { status: 404 });
  }
  const subAccountId = snap.data()!.subAccountId as string;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  await db.recursiveDelete(ref);
  return NextResponse.json({ ok: true, formId: id });
}

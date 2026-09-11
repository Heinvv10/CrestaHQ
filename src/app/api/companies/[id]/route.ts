import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { deleteCompanyAndUnlinkContacts } from "@/lib/server/companies-service";

/**
 * Delete a company. Admin-only (matches the `companies` delete rule) and
 * server-side so the contacts that point at it are unlinked in the same
 * batch — a client-side delete would leave dangling `companyId`s behind
 * whenever a contact sat outside the caller's territory.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`companies/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }
  const subAccountId = snap.data()?.subAccountId as string;

  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const unlinked = await deleteCompanyAndUnlinkContacts(db, id);
  return NextResponse.json({ ok: true, unlinked });
}

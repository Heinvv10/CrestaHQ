import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import type { AssignableMember } from "@/types";

/**
 * GET /api/sub-accounts/[id]/members — the assignee roster.
 *
 * Any active member may read it: the "Assigned to" pickers on contacts,
 * deals and tasks need every name, but the client-SDK rule on
 * `subAccountMembers` only lets admins list the collection (collaborators
 * read their own row). Returns the display fields only — never
 * `assignedTerritoryIds` or the membership audit fields — and a member's
 * email only when they have no display name to show instead.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/subAccountMembers`)
    .where("status", "==", "active")
    .get();
  const members: AssignableMember[] = snap.docs
    .map((d) => {
      const m = d.data();
      const displayName = ((m.displayName as string) ?? "").trim();
      // Email is exposed ONLY as the label fallback for a member who never
      // set a display name; otherwise collaborators don't need it.
      return {
        uid: d.id,
        displayName: displayName || (m.email as string) || d.id,
        email: displayName ? "" : ((m.email as string) ?? ""),
        role: (m.role as string) ?? "collaborator",
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return NextResponse.json({ members });
}

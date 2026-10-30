import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { canSeeTerritory, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { statusFilter, toProposalViews } from "@/lib/server/agent-proposals-view";

/**
 * List a sub-account's agent proposals, newest first (optionally one
 * `?status=`; `open` = pending + unsettled, the actionable rows the page and
 * the sidebar badge show; `recent` = the terminal ones),
 * for any member — minus scoped rows whose `territoryId` is
 * outside a territory-scoped caller's territories (a preview carries the
 * target's name and the message), exactly as firestore.rules' canSeeProposal.
 * The supported read path for the approvals UI: rules are not filters, so a
 * client list query is refused for scoped collaborators.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const status = new URL(request.url).searchParams.get("status");
  const statuses = status === null ? null : statusFilter(status);
  if (status !== null && !statuses) {
    return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  }
  let q = getAdminDb()
    .collection("agentProposals")
    .where("subAccountId", "==", subAccountId);
  if (statuses && statuses.length > 1) q = q.where("status", "in", statuses);
  else if (statuses) q = q.where("status", "==", statuses[0]);
  const snap = await q.orderBy("createdAt", "desc").limit(100).get();
  const scope = await territoryScopeFor({ ...access, subAccountId });
  const visible = snap.docs.filter(
    (d) =>
      d.data().targetScoped === false ||
      canSeeTerritory(scope, d.data().territoryId),
  );
  return NextResponse.json({
    proposals: await toProposalViews(subAccountId, visible),
  });
}

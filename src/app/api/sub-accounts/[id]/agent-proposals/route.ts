import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { canSeeTerritory, territoryScopeFor } from "@/lib/ai-suite/territory-scope";

const STATUSES = new Set([
  "pending",
  "executing",
  "executed",
  "failed",
  "rejected",
  "expired",
  "unsettled",
]);

/**
 * List a sub-account's agent proposals, newest first (optionally one
 * `?status=`), for any member — minus scoped rows whose `territoryId` is
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
  if (status !== null && !STATUSES.has(status)) {
    return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  }
  let q = getAdminDb()
    .collection("agentProposals")
    .where("subAccountId", "==", subAccountId);
  if (status) q = q.where("status", "==", status);
  const snap = await q.orderBy("createdAt", "desc").limit(100).get();
  const scope = await territoryScopeFor({ ...access, subAccountId });
  const visible = snap.docs.filter(
    (d) =>
      d.data().targetScoped === false ||
      canSeeTerritory(scope, d.data().territoryId),
  );
  return NextResponse.json({
    proposals: visible.map((d) => ({ id: d.id, ...d.data() })),
  });
}

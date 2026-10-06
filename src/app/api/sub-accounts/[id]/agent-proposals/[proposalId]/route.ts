import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getCapability,
  roleSatisfies,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { proposalVisible } from "@/lib/server/agent-approval-checks";
import { decideProposal, readDecideBody, refusedApproval } from "@/lib/server/agent-proposals-decide";

/**
 * Decide an agent proposal of this sub-account. Every decision needs the
 * capability's own role (as the AI Suite confirm route), admin for
 * `hard_delete`, and territory access to the proposal's contact; the rest —
 * reject, mark_*, approve's re-checks (for an agency key's row, also what
 * auth checks of it: its agency's Agent API switch and its minter still an
 * owner), the preview refresh, the claim and the execute — is
 * `decideProposal`, shared with the agency route.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; proposalId: string }> },
) {
  const { id: subAccountId, proposalId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const body = await readDecideBody(request);
  if (body instanceof NextResponse) return body;

  const db = getAdminDb();
  const snap = await db.doc(`agentProposals/${proposalId}`).get();
  const proposal = snap.data();
  if (!proposal || proposal.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  const cap = getCapability(proposal.capability as string);
  const roleCtx = {
    agencyRoleIsOwner: access.subAccountRole === "agencyOwner",
    subAccountRole: access.subAccountRole,
  };
  if (
    !roleSatisfies(cap?.requiredRole ?? "subAccountAdmin", roleCtx) ||
    (proposal.approval === "hard_delete" &&
      !roleSatisfies("subAccountAdmin", roleCtx))
  ) {
    return NextResponse.json(
      { error: "You don't have permission to decide this action." },
      { status: 403 },
    );
  }
  const actionCtx: AiSuiteActionContext = {
    uid: access.uid,
    email: access.email,
    displayName: "",
    agencyId: access.agencyId ?? "",
    subAccountId,
    subAccountRole: access.subAccountRole,
  };
  // firestore.rules' canSeeProposal; the claim re-checks it on the row it reads.
  const scope = proposal.targetScoped !== false ? await territoryScopeFor(actionCtx) : null;
  if (!proposalVisible(proposal, scope)) return refusedApproval("not_visible");

  return decideProposal({ proposalId, proposal, body, targetSubAccountId: subAccountId, actionCtx, scope });
}

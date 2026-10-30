import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCapability, roleSatisfies, type AiSuiteActionContext } from "@/lib/ai-suite/capabilities";
import { territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { isDocId } from "@/lib/server/doc-id";
import { proposalTarget, proposalVisible } from "@/lib/server/agent-approval-checks";
import { decideProposal, readDecideBody, refusedApproval } from "@/lib/server/agent-proposals-decide";

const NOT_FOUND = () => NextResponse.json({ error: "Proposal not found" }, { status: 404 });

/**
 * The agency owner decides one of their agency keys' rows (AGENCY_AGENT_API_PLAN.md
 * D4), agency-level or sub-account-scoped, by the same sequence as the
 * sub-account route (`decideProposal`), acting on the row's target
 * (`proposalTarget`). Another agency's row, a sub-account key's row and an
 * unknown id get one identical 404. The agency's Agent API switch is part
 * of approve's checks (`approvalRefusal` → `agencyKeyStanding`); reject is
 * always allowed. Body: `{decision, rev}` as the sub-account route.
 */
export async function POST(request: Request, ctx: { params: Promise<{ proposalId: string }> }) {
  const { proposalId } = await ctx.params;
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  const body = await readDecideBody(request);
  if (body instanceof NextResponse) return body;

  if (!isDocId(proposalId)) return NOT_FOUND();
  const proposal = (await getAdminDb().doc(`agentProposals/${proposalId}`).get()).data();
  const target = proposal ? proposalTarget(proposal) : null;
  if (!proposal || !target || proposal.agencyId !== caller.agencyId || proposal.keyLevel !== "agency") {
    return NOT_FOUND();
  }

  const cap = getCapability(proposal.capability as string);
  if (!roleSatisfies(cap?.requiredRole ?? "subAccountAdmin", { agencyRoleIsOwner: true, subAccountRole: "agencyOwner" })) {
    return NextResponse.json({ error: "You don't have permission to decide this action." }, { status: 403 });
  }
  const actionCtx: AiSuiteActionContext = {
    uid: caller.uid,
    email: caller.email,
    displayName: "",
    agencyId: caller.agencyId!,
    subAccountId: target,
    subAccountRole: "agencyOwner",
  };
  const scope = proposal.targetScoped !== false ? await territoryScopeFor(actionCtx) : null;
  if (!proposalVisible(proposal, scope)) return refusedApproval("not_visible");

  return decideProposal({ proposalId, proposal, body, targetSubAccountId: target, actionCtx, scope });
}

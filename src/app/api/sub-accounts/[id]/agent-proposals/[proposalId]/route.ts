import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  CapabilityUserError,
  getCapability,
  roleSatisfies,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { canSeeTerritory, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import {
  claimProposal,
  settleProposal,
  transitionIf,
} from "@/lib/server/agent-proposals";
import { replayHeldEnrolment } from "@/lib/server/agent-enrolment-replay";

const DECISIONS = ["approve", "reject", "mark_sent", "mark_not_sent"] as const;
type Decision = (typeof DECISIONS)[number];

/**
 * Decide an agent proposal. Every decision needs the capability's own role
 * (as the AI Suite confirm route), admin for `hard_delete`, and territory
 * access to the proposal's contact. `approve` also re-checks both agency
 * gates, then CLAIMS the row (`pending` → `executing` in a transaction) before
 * running anything, so two approvers can never both execute it. `reject` is
 * legal only on `pending`; `mark_sent` / `mark_not_sent` only on `unsettled`.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; proposalId: string }> },
) {
  const { id: subAccountId, proposalId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let decision: Decision;
  try {
    decision = ((await request.json()) as { decision?: Decision }).decision!;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ error: "Unknown decision" }, { status: 400 });
  }

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
  if (typeof proposal.contactId === "string") {
    const contact = await db.doc(`contacts/${proposal.contactId}`).get();
    const scope = await territoryScopeFor(actionCtx);
    if (!canSeeTerritory(scope, contact.data()?.territoryId)) {
      return NextResponse.json(
        { error: "That contact isn't in one of your assigned territories." },
        { status: 403 },
      );
    }
  }

  const decided = {
    decidedAt: new Date(),
    decidedByUid: access.uid,
    decidedByEmail: access.email,
  };
  const conflict = () =>
    NextResponse.json(
      { error: "already_decided", status: proposal.status },
      { status: 409 },
    );
  if (decision === "reject") {
    const ok = await transitionIf(proposalId, "pending", {
      status: "rejected",
      reason: "rejected_by_approver",
      ...decided,
    });
    return ok ? NextResponse.json({ status: "rejected" }) : conflict();
  }
  if (decision === "mark_sent" || decision === "mark_not_sent") {
    const ok = await transitionIf(
      proposalId,
      "unsettled",
      decision === "mark_sent"
        ? { status: "executed", settledBy: "human", ...decided }
        : { status: "rejected", reason: "not_sent_confirmed", ...decided },
    );
    return ok
      ? NextResponse.json({ status: decision === "mark_sent" ? "executed" : "rejected" })
      : conflict();
  }

  // ── approve
  const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data();
  if (sub?.agentApiEnabledByAgency !== true || sub?.apiAccessEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Agent API access is disabled for this sub-account." },
      { status: 403 },
    );
  }
  const enrolment = proposal.approval === "workflow_enrolment";
  const args = proposal.args as Record<string, unknown>;
  // Enrolment rows store the held trigger input, not capability args.
  if (!enrolment) {
    const validated = cap?.validate(args);
    if (!validated?.ok) {
      return NextResponse.json(
        { error: `Can't run that action: ${validated?.error ?? "unknown action"}.` },
        { status: 400 },
      );
    }
  }

  const claimedAtMs = await claimProposal(proposalId, access);
  if (claimedAtMs === null) return conflict();

  let outcome: Parameters<typeof settleProposal>[2];
  try {
    const result = enrolment
      ? await replayHeldEnrolment({ id: proposalId, ...proposal }, actionCtx)
      : await cap!.execute(actionCtx, args);
    outcome = {
      status: "executed",
      result: { resultText: result.resultText, ref: result.ref ?? null },
    };
  } catch (err) {
    if (!(err instanceof CapabilityUserError)) {
      console.error(`[agent-proposals] approve ${proposalId} failed:`, err);
    }
    outcome = {
      status: "failed",
      error:
        err instanceof CapabilityUserError
          ? err.message
          : "The action failed to run.",
    };
  }
  await settleProposal(proposalId, claimedAtMs, outcome, {
    agencyId: proposal.agencyId as string,
    subAccountId,
    capability: proposal.capability as string,
    args,
    summary: proposal.summary as string,
    confirmedByUid: access.uid,
    confirmedByEmail: access.email,
  });
  return outcome.status === "executed"
    ? NextResponse.json({ status: "executed", resultText: outcome.result.resultText })
    : NextResponse.json({ status: "failed", error: outcome.error }, { status: 422 });
}

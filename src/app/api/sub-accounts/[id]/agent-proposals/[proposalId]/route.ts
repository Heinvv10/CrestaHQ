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
import { territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { buildPreviewContext } from "@/lib/api/agent-context";
import {
  assertPinnedWhenOutbound,
  canonical,
  millis,
  normalizePreview,
  proposalTooLarge,
} from "@/lib/server/agent-proposals-encoding";
import {
  claimProposal,
  MARK_MIN_AGE_MS,
  refreshPreview,
  transitionIf,
  type TransitionResult,
} from "@/lib/server/agent-proposals";
import {
  approvalRefusal,
  pastExpiry,
  proposalVisible,
  type ClaimRefusal,
} from "@/lib/server/agent-approval-checks";
import { executeAndSettle } from "@/lib/server/agent-proposals-settle";
import { replayHeldEnrolment } from "@/lib/server/agent-enrolment-replay";
import { currentHeldEnrolmentPreview } from "@/lib/server/agent-held-enrolment";

const DECISIONS = ["approve", "reject", "mark_sent", "mark_not_sent"] as const;
/** The answer to each refusal, early or from the claim (agent-approval-checks.ts). */
const APPROVAL_REFUSAL: Record<ClaimRefusal, [number, string]> = {
  not_visible: [403, "That record isn't in one of your assigned territories."],
  gate_off: [403, "Agent API access is disabled for this sub-account."],
  wrong_agency: [404, "Proposal not found"],
  no_agency: [403, "The agency of the API key that proposed this no longer exists."],
  agent_api_disabled: [403, "The Agent API is switched off for this agency."],
  minter_removed: [403, "The agency owner who minted the API key that proposed this is no longer an active owner."],
  key_revoked: [409, "key_revoked"],
  expired: [409, "expired"],
};
const refusedApproval = (refusal: ClaimRefusal) =>
  NextResponse.json({ error: APPROVAL_REFUSAL[refusal][1] }, { status: APPROVAL_REFUSAL[refusal][0] });
type Decision = (typeof DECISIONS)[number];

/**
 * Decide an agent proposal. Every decision needs the capability's own role
 * (as the AI Suite confirm route), admin for `hard_delete`, and territory
 * access to the proposal's contact. `approve` also re-checks both agency
 * gates and the proposing key (for an agency key's row, also what auth
 * checks of it: its agency's Agent API switch and its minter still an
 * owner) — `approvalRefusal` — re-computes the preview (a changed one is
 * stored and refused, so the approver sees what will really happen), then
 * CLAIMS the row (`pending` → `executing` in a transaction that re-runs the
 * territory, `approvalRefusal` and expiry checks on what it reads) before
 * running anything, so two approvers can never both execute it, and nothing
 * revoked, switched off, re-tagged or expired meanwhile runs. `reject` is legal
 * only on `pending`; `mark_sent` / `mark_not_sent` only on `unsettled`. Every
 * decision but `reject` (refusing is always safe) names the row generation
 * (`rev`) the approver saw: a row re-proposed or refreshed since is 409
 * `stale_proposal`. `mark_*` wait MARK_MIN_AGE_MS after the claim, so a
 * person cannot guess the outcome of an execute that may still be running.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; proposalId: string }> },
) {
  const { id: subAccountId, proposalId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { decision?: Decision; rev?: unknown; acknowledgePriorAttempt?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const decision = body.decision!;
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ error: "Unknown decision" }, { status: 400 });
  }
  if (decision !== "reject" && (typeof body.rev !== "string" || !body.rev)) {
    return NextResponse.json({ error: "`rev` is required" }, { status: 400 });
  }
  const rev = body.rev as string;

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

  const decided = {
    decidedAt: new Date(),
    decidedByUid: access.uid,
    decidedByEmail: access.email,
  };
  const refused = (moved: Exclude<TransitionResult, "ok">) =>
    NextResponse.json(
      { error: moved === "stale" ? "stale_proposal" : "already_decided" },
      { status: 409 },
    );
  if (decision === "reject") {
    const moved = await transitionIf(proposalId, "pending", {
      status: "rejected",
      reason: "rejected_by_approver",
      ...decided,
    });
    return moved === "ok" ? NextResponse.json({ status: "rejected" }) : refused(moved);
  }
  if (decision === "mark_sent" || decision === "mark_not_sent") {
    const claimedAtMs = millis(proposal.claimedAt);
    if (claimedAtMs !== null && Date.now() < claimedAtMs + MARK_MIN_AGE_MS) {
      return NextResponse.json({ error: "claim_too_recent" }, { status: 409 });
    }
    const moved = await transitionIf(
      proposalId,
      "unsettled",
      decision === "mark_sent"
        ? { status: "executed", settledBy: "human", ...decided }
        : { status: "rejected", reason: "not_sent_confirmed", ...decided },
      { rev },
    );
    return moved === "ok"
      ? NextResponse.json({ status: decision === "mark_sent" ? "executed" : "rejected" })
      : refused(moved);
  }

  // ── approve
  // The key may have been revoked after this row was written (or its revoke
  // sweep failed): the row dies with the key. The claim re-reads all of it.
  const refusal = await approvalRefusal(proposal);
  if (refusal === "key_revoked") {
    const moved = await transitionIf(
      proposalId,
      "pending",
      { status: "rejected", reason: "key_revoked", decidedAt: new Date() },
      { rev },
    );
    return moved === "ok" ? refusedApproval("key_revoked") : refused(moved);
  }
  if (refusal) return refusedApproval(refusal);
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

  if (pastExpiry(proposal)) {
    const moved = await transitionIf(
      proposalId,
      "pending",
      { status: "expired", decidedAt: new Date() },
      { rev },
    );
    return moved === "ok" ? refusedApproval("expired") : refused(moved);
  }

  // execute reads live data; the preview was computed when proposed. If
  // what would happen now differs, store it and make the approver look again.
  // Same neutral ctx as at propose time, so who approves cannot change it.
  // A held enrolment's preview is rebuilt from the workflow's current steps.
  let pinned = (proposal.pinned ?? null) as Record<string, unknown> | null;
  let fresh: ReturnType<typeof normalizePreview> | null = null;
  if (enrolment) {
    fresh = await currentHeldEnrolmentPreview(proposal);
  } else if (cap?.preview) {
    try {
      fresh = normalizePreview(
        await cap.preview(buildPreviewContext(proposal.agencyId as string, subAccountId), args),
      );
    } catch (err) {
      // e.g. the contact was deleted: nothing to review, nothing claimed.
      if (err instanceof CapabilityUserError) {
        return NextResponse.json({ error: "preview_unavailable", message: err.message }, { status: 409 });
      }
      console.error(`[agent-proposals] preview for ${proposalId} failed:`, err);
      return NextResponse.json({ error: "The preview could not be built." }, { status: 500 });
    }
    try {
      assertPinnedWhenOutbound(proposal.capability as string, proposal.approval as string, fresh);
    } catch (err) {
      console.error(`[agent-proposals] ${proposalId}:`, err);
      return NextResponse.json({ error: "The preview could not be built." }, { status: 500 });
    }
  }
  if (fresh) {
    const stored = { rows: proposal.preview, pinned };
    if (canonical(fresh) !== canonical(stored)) {
      // Grown past what a row can hold (e.g. the record was edited since):
      // nothing is stored, the approver rejects it and the agent proposes again.
      if (proposalTooLarge(args, fresh)) {
        return NextResponse.json(
          { error: "preview_unavailable", message: "What this would do is now too large to review. Reject it and propose a smaller change." },
          { status: 409 },
        );
      }
      const nextRev = await refreshPreview(proposalId, rev, fresh);
      return nextRev
        ? NextResponse.json(
            { error: "preview_changed", rev: nextRev, preview: fresh.rows },
            { status: 409 },
          )
        : NextResponse.json({ error: "stale_proposal" }, { status: 409 });
    }
    pinned = fresh.pinned;
  }

  // An earlier generation of this exact action did go out (its late settle
  // said so). Approving again is a deliberate re-send, so it must be said.
  if (proposal.priorAttemptSent && body.acknowledgePriorAttempt !== true) {
    return NextResponse.json(
      { error: "previous_attempt_sent", priorAttemptSent: proposal.priorAttemptSent },
      { status: 409 },
    );
  }

  const claim = await claimProposal(proposalId, access, rev, scope);
  if (claim === "conflict" || claim === "stale") return refused(claim);
  // Any check above that stopped passing between it and the claim.
  if (typeof claim === "string") return refusedApproval(claim);
  const { claimId } = claim;

  const outcome = await executeAndSettle({
    id: proposalId,
    claimId,
    execute: (signal) => {
      const execCtx = {
        ...actionCtx,
        approved: { pinned, keyPrefix: proposal.keyPrefix as string | undefined, proposalId, claimId },
        signal,
      };
      return enrolment
        ? replayHeldEnrolment({ id: proposalId, ...proposal }, execCtx)
        : cap!.execute(execCtx, args);
    },
    audit: {
      agencyId: proposal.agencyId as string,
      subAccountId,
      capability: proposal.capability as string,
      args,
      summary: proposal.summary as string,
      confirmedByUid: access.uid,
      confirmedByEmail: access.email,
    },
  });
  if (outcome === "deadline") {
    return NextResponse.json({ status: "unsettled" }, { status: 202 });
  }
  return outcome.status === "executed"
    ? NextResponse.json({ status: "executed", resultText: outcome.result.resultText })
    : NextResponse.json({ status: "failed", error: outcome.error }, { status: 422 });
}

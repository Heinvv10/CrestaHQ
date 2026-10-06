import "server-only";

import { NextResponse } from "next/server";
import {
  CapabilityUserError,
  getCapability,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { buildPreviewContext } from "@/lib/api/agent-context";
import type { EffectiveTerritoryScope } from "@/lib/auth/territory-filter";
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
import { approvalRefusal, pastExpiry, type ClaimRefusal } from "@/lib/server/agent-approval-checks";
import { executeAndSettle } from "@/lib/server/agent-proposals-settle";
import { replayHeldEnrolment } from "@/lib/server/agent-enrolment-replay";
import { currentHeldEnrolmentPreview } from "@/lib/server/agent-held-enrolment";

/**
 * Deciding an agent proposal once the route has authorised the person: the
 * sequence the sub-account decide route and the agency one share
 * (AGENCY_AGENT_API_PLAN.md D4). Each route checks who may decide which row
 * and builds the approver's `actionCtx` and territory `scope`; everything
 * from there on — reject, mark_*, and approve's checks (`approvalRefusal`,
 * args, expiry, the rebuilt preview, a prior attempt), its `rev`-guarded
 * claim and the execute — happens here, the same for both.
 */

export const DECISIONS = ["approve", "reject", "mark_sent", "mark_not_sent"] as const;
export type Decision = (typeof DECISIONS)[number];

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
export const refusedApproval = (refusal: ClaimRefusal) =>
  NextResponse.json({ error: APPROVAL_REFUSAL[refusal][1] }, { status: APPROVAL_REFUSAL[refusal][0] });

export interface DecideBody {
  decision: Decision;
  /** The row generation the person saw; absent only for `reject`. */
  rev: string;
  /** The row's `gen` the person saw (createProposal); absent = not checked. */
  gen?: string;
  acknowledgePriorAttempt?: unknown;
}

/** The request body, or the 400 for a malformed one. Read before the row. */
export async function readDecideBody(request: Request): Promise<DecideBody | NextResponse> {
  let body: { decision?: Decision; rev?: unknown; gen?: unknown; acknowledgePriorAttempt?: unknown };
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
  if (body.gen !== undefined && (typeof body.gen !== "string" || !body.gen)) {
    return NextResponse.json({ error: "`gen` must be a non-empty string" }, { status: 400 });
  }
  return {
    decision,
    rev: body.rev as string,
    gen: body.gen as string | undefined,
    acknowledgePriorAttempt: body.acknowledgePriorAttempt,
  };
}

export interface DecideInput {
  proposalId: string;
  proposal: FirebaseFirestore.DocumentData;
  body: DecideBody;
  /** The sub-account the row acts on (`proposalTarget`): the preview ctx
   *  and the audit row's sub-account. Never null. */
  targetSubAccountId: string;
  /** The approver as execute runs: their uid / email, the agency, the target. */
  actionCtx: AiSuiteActionContext;
  /** The approver's territory scope; null for a tenant-wide row. */
  scope: EffectiveTerritoryScope | null;
}

/**
 * `reject` is legal only on `pending`; `mark_sent` / `mark_not_sent` only on
 * `unsettled`. `approve` re-checks the proposing key and both reach gates
 * (`approvalRefusal`), re-computes the preview (a changed one is stored and
 * refused, so the approver sees what will really happen), then CLAIMS the
 * row (`pending` → `executing` in a transaction that re-runs the territory,
 * `approvalRefusal` and expiry checks) before running anything, so two
 * approvers can never both execute it. Every decision but `reject`
 * (refusing is always safe) names the row generation (`rev`) the approver
 * saw: a row re-proposed or refreshed since is 409 `stale_proposal`. A
 * decision naming the row's `gen` (the generation, which a refresh keeps) is
 * 409 `stale_proposal` when the row is another generation by now, reject
 * included: a stale card never rejects a different key's generation.
 * `mark_*` wait MARK_MIN_AGE_MS after the claim, so a person cannot guess
 * the outcome of an execute that may still be running.
 */
export async function decideProposal(input: DecideInput): Promise<NextResponse> {
  const { proposalId, proposal, body, targetSubAccountId, actionCtx, scope } = input;
  const { decision, rev, gen } = body;
  const cap = getCapability(proposal.capability as string);
  const decided = {
    decidedAt: new Date(),
    decidedByUid: actionCtx.uid,
    decidedByEmail: actionCtx.email,
  };
  const refused = (moved: Exclude<TransitionResult, "ok">) =>
    NextResponse.json(
      { error: moved === "stale" ? "stale_proposal" : "already_decided" },
      { status: 409 },
    );
  if (gen !== undefined && proposal.gen !== gen) return refused("stale");
  if (decision === "reject") {
    const moved = await transitionIf(
      proposalId,
      "pending",
      { status: "rejected", reason: "rejected_by_approver", ...decided },
      { gen },
    );
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
        await cap.preview(buildPreviewContext(proposal.agencyId as string, targetSubAccountId), args),
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

  const claim = await claimProposal(proposalId, actionCtx, rev, scope);
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
      subAccountId: targetSubAccountId,
      capability: proposal.capability as string,
      args,
      summary: proposal.summary as string,
      confirmedByUid: actionCtx.uid,
      confirmedByEmail: actionCtx.email,
    },
  });
  if (outcome === "deadline") {
    return NextResponse.json({ status: "unsettled" }, { status: 202 });
  }
  return outcome.status === "executed"
    ? NextResponse.json({ status: "executed", resultText: outcome.result.resultText })
    : NextResponse.json({ status: "failed", error: outcome.error }, { status: 422 });
}

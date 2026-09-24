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
import { buildPreviewContext } from "@/lib/api/agent-context";
import { canonical, millis, normalizePreview } from "@/lib/server/agent-proposals-encoding";
import {
  claimProposal,
  EXECUTE_DEADLINE_MS,
  MARK_MIN_AGE_MS,
  refreshPreview,
  settleProposal,
  transitionIf,
  type TransitionResult,
} from "@/lib/server/agent-proposals";
import { replayHeldEnrolment } from "@/lib/server/agent-enrolment-replay";

const DECISIONS = ["approve", "reject", "mark_sent", "mark_not_sent"] as const;
type Decision = (typeof DECISIONS)[number];

/**
 * Decide an agent proposal. Every decision needs the capability's own role
 * (as the AI Suite confirm route), admin for `hard_delete`, and territory
 * access to the proposal's contact. `approve` also re-checks both agency
 * gates and the proposing key, re-computes the preview (a changed one is
 * stored and refused, so the approver sees what will really happen), then
 * CLAIMS the row (`pending` → `executing` in a transaction) before running
 * anything, so two approvers can never both execute it. `reject` is legal
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

  let body: { decision?: Decision; rev?: unknown };
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

  // The key may have been revoked after this row was written (or its revoke
  // sweep failed): the row dies with the key.
  const key = (
    await db.doc(`subAccounts/${subAccountId}/apiKeys/${proposal.keyId}`).get()
  ).data();
  if (!key || key.revokedAt) {
    const moved = await transitionIf(
      proposalId,
      "pending",
      { status: "rejected", reason: "key_revoked", decidedAt: new Date() },
      { rev },
    );
    return moved === "ok"
      ? NextResponse.json({ error: "key_revoked" }, { status: 409 })
      : refused(moved);
  }

  if ((millis(proposal.expiresAt) ?? Infinity) < Date.now()) {
    const moved = await transitionIf(
      proposalId,
      "pending",
      { status: "expired", decidedAt: new Date() },
      { rev },
    );
    return moved === "ok"
      ? NextResponse.json({ error: "expired" }, { status: 409 })
      : refused(moved);
  }

  // execute reads live data; the preview was computed when proposed. If
  // what would happen now differs, store it and make the approver look again.
  // Same neutral ctx as at propose time, so who approves cannot change it.
  let pinned = (proposal.pinned ?? null) as Record<string, unknown> | null;
  if (!enrolment && cap?.preview) {
    let fresh: ReturnType<typeof normalizePreview>;
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
    const stored = { rows: proposal.preview, pinned };
    if (canonical(fresh) !== canonical(stored)) {
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

  const claim = await claimProposal(proposalId, access, rev);
  if (typeof claim === "string") return refused(claim);
  const { claimId } = claim;

  // Run and settle under a hard deadline, well inside the sweep's stale-claim
  // window: past it, this process marks the row `unsettled` itself and the
  // real outcome, whenever it lands, arrives through the late-settle path.
  const abort = new AbortController();
  const execCtx = { ...actionCtx, approved: { pinned }, signal: abort.signal };
  const run = (async () => {
    let outcome: Parameters<typeof settleProposal>[2];
    try {
      const result = enrolment
        ? await replayHeldEnrolment({ id: proposalId, ...proposal }, execCtx)
        : await cap!.execute(execCtx, args);
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
    await settleProposal(proposalId, claimId, outcome, {
      agencyId: proposal.agencyId as string,
      subAccountId,
      capability: proposal.capability as string,
      args,
      summary: proposal.summary as string,
      confirmedByUid: access.uid,
      confirmedByEmail: access.email,
    });
    return outcome;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), EXECUTE_DEADLINE_MS);
  });
  const outcome = await Promise.race([run, deadline]);
  clearTimeout(timer);
  if (outcome === "deadline") {
    abort.abort();
    await transitionIf(proposalId, "executing", { status: "unsettled" }, { claimId });
    return NextResponse.json({ status: "unsettled" }, { status: 202 });
  }
  return outcome.status === "executed"
    ? NextResponse.json({ status: "executed", resultText: outcome.result.resultText })
    : NextResponse.json({ status: "failed", error: outcome.error }, { status: 422 });
}

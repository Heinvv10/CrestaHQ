import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { ApiAuthContext } from "@/lib/api/auth";
import { buildAgentContext, buildPreviewContext } from "@/lib/api/agent-context";
import { recordAgentWrite } from "@/lib/api/agent-audit";
import type { HeldEnrolment, HoldFailure } from "@/lib/workflows/agent-hold";
import {
  availableOn,
  CapabilityUserError,
  getCapability,
  roleSatisfies,
  type AiSuiteCapability,
} from "@/lib/ai-suite/capabilities";
import {
  createProposal,
  OUTCOME_UNKNOWN_MESSAGE,
  type ProposalStatus,
} from "@/lib/server/agent-proposals";
import {
  assertPinnedWhenOutbound,
  normalizePreview,
} from "@/lib/server/agent-proposals-encoding";

export type AgentDispatchResult =
  | {
      ok: true;
      resultText: string;
      /** The validated args that ran (for logs; never the raw args). */
      args: Record<string, unknown>;
      ref?: { kind: string; id: string };
      /** A read that hit its row cap: the result may be incomplete. */
      truncated?: true;
      /** Workflow enrolments the write caused, held for approval (ruling Q). */
      held?: Array<Pick<HeldEnrolment, "proposalId" | "workflowName">>;
      /** Matched workflows whose enrolment was neither queued nor run. */
      holdFailures?: HoldFailure[];
    }
  | {
      ok: true;
      /** The validated args that were queued (for logs). */
      args: Record<string, unknown>;
      /** Queued for a person to approve (HTTP 202). */
      proposal: {
        id: string;
        status: ProposalStatus;
        summary: string;
        preview: Array<{ label: string; value: string }>;
      };
    }
  | { ok: false; code: string; httpStatus: number; message: string };

const refuse = (
  code: string,
  httpStatus: number,
  message: string
): AgentDispatchResult => ({ ok: false, code, httpStatus, message });

/** One response for every name the agent may not call, so it cannot probe
 *  which chat-only or agency-level names exist. */
const notAvailable = (): AgentDispatchResult =>
  refuse("not_available", 404, "No such tool is available to this key.");

/**
 * Whether an agent key may call `cap` at all — the ONE predicate behind
 * dispatch, the tools listing and the REST hooks, so none can disagree or
 * leak which chat-only names exist: sub-account level, surfaced to agents,
 * runnable as a sub-account admin, and never the engine-only
 * workflow_enrolment class (only the engine writes those rows; a capability
 * claiming it would let an agent forge one).
 */
export function agentCallable(cap: AiSuiteCapability): boolean {
  return (
    cap.level === "sub-account" &&
    availableOn(cap, "agent") &&
    cap.approval !== "workflow_enrolment" &&
    roleSatisfies(cap.requiredRole, { agencyRoleIsOwner: false, subAccountRole: "admin" })
  );
}

/** A write tool the key may call: the only kind whose bodies a request log
 *  keeps. A read's args and result are PII; an unknown or non-callable
 *  name's args may be too (a misspelled read), so neither is logged. */
export function isAgentWriteTool(name: string): boolean {
  const cap = getCapability(name);
  return !!cap && agentCallable(cap) && cap.readonly !== true;
}

/** A read tool the key may call. Anything else — including a chat-only or
 *  unknown name — is treated alike, so the REST and MCP hooks can't reveal
 *  which exist. */
export function isAgentReadTool(name: string): boolean {
  const cap = getCapability(name);
  return !!cap && agentCallable(cap) && cap.readonly === true;
}

/**
 * The ONE choke point for agent tool calls (MCP and REST). Every refusal
 * runs before any capability code: scope, test mode, the agency's Agent API
 * gate (read fresh on every call, so switching it off makes keys inert
 * immediately), then surface / level / role. A capability with an
 * `approval` class is never executed here: it becomes an `agentProposals`
 * row a person approves. Nothing thrown anywhere in the
 * pipeline escapes: a CapabilityUserError is a 400 with its message, anything
 * else a generic 500.
 */
export async function dispatchAgentTool(
  auth: ApiAuthContext,
  name: string,
  rawArgs: unknown
): Promise<AgentDispatchResult> {
  try {
    return await dispatch(auth, name, rawArgs);
  } catch (err) {
    if (err instanceof CapabilityUserError) {
      return refuse("invalid_request", 400, err.message);
    }
    // `name` is caller-supplied: quote and cap it so it cannot forge log lines.
    console.error(
      `[agent-dispatch] ${JSON.stringify(String(name).slice(0, 80))} failed:`,
      err
    );
    return refuse("internal_error", 500, "The tool failed to run.");
  }
}

async function dispatch(
  auth: ApiAuthContext,
  name: string,
  rawArgs: unknown
): Promise<AgentDispatchResult> {
  if (!auth.scopes.includes("agent")) {
    return refuse(
      "insufficient_scope",
      403,
      "This API key does not have the 'agent' scope."
    );
  }
  if (auth.mode === "test") {
    return refuse(
      "test_mode_unsupported",
      400,
      "Agent tools run on live keys only."
    );
  }
  const subSnap = await getAdminDb()
    .doc(`subAccounts/${auth.subAccountId}`)
    .get();
  if (subSnap.data()?.agentApiEnabledByAgency !== true) {
    return refuse(
      "agent_api_disabled",
      403,
      "Agent API access has been disabled for this sub-account by your agency administrator."
    );
  }

  const cap = getCapability(name);
  if (!cap || !agentCallable(cap)) return notAvailable();

  // Narrow before validate, so a stored proposal re-validates idempotently.
  const raw =
    cap.agentArgs && rawArgs && typeof rawArgs === "object"
      ? cap.agentArgs(rawArgs as Record<string, unknown>)
      : rawArgs;
  const validated = cap.validate(raw);
  if (!validated.ok) {
    return refuse("invalid_args", 400, validated.error);
  }

  const ctx = buildAgentContext(auth);
  const approval = cap.approvalFor ? await cap.approvalFor(validated.args, ctx) : cap.approval;
  // Only the engine writes workflow_enrolment rows (see agentCallable).
  if (approval === "workflow_enrolment") return notAvailable();
  if (approval) {
    // The approver sees `preview` verbatim; a queued action without one
    // could not be judged, so it is a registry bug, not a proposal.
    if (!cap.preview) throw new Error(`${cap.name} has approval but no preview`);
    if (!cap.approvalTarget) throw new Error(`${cap.name} has approval but no approvalTarget`);
    const previewCtx = buildPreviewContext(auth.agencyId, auth.subAccountId);
    const target = await cap.approvalTarget(previewCtx, validated.args);
    const reviewed = normalizePreview(
      await cap.preview(previewCtx, validated.args)
    );
    assertPinnedWhenOutbound(cap.name, approval, reviewed);
    const created = await createProposal({
      agencyId: auth.agencyId,
      subAccountId: auth.subAccountId,
      keyId: auth.keyId,
      keyPrefix: auth.keyPrefix,
      capability: cap.name,
      approval,
      args: validated.args,
      summary: cap.summarize(validated.args),
      preview: reviewed.rows,
      pinned: reviewed.pinned,
      target,
    });
    if (!created.ok) {
      return created.code === "key_revoked"
        ? refuse("key_revoked", 401, "This API key has been revoked.")
        : refuse("outcome_unknown", 409, OUTCOME_UNKNOWN_MESSAGE);
    }
    const { id, status, summary, preview } = created;
    return { ok: true, args: validated.args, proposal: { id, status, summary, preview } };
  }

  const result = await cap.execute(ctx, validated.args);
  if (!cap.readonly) await recordAgentWrite(auth, cap.name, validated.args, result.ref);
  return {
    ok: true,
    resultText: result.resultText,
    args: validated.args,
    ...(result.ref ? { ref: result.ref } : {}),
    ...(result.truncated ? { truncated: true as const } : {}),
    ...(result.held
      ? {
          held: result.held.map(({ proposalId, workflowName }) => ({ proposalId, workflowName })),
          holdFailures: result.holdFailures ?? [],
        }
      : {}),
  };
}

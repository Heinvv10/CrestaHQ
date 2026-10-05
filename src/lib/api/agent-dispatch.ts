import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";
import { buildAgencyAgentContext, buildAgentContext, buildPreviewContext } from "@/lib/api/agent-context";
import { NO_SUCH_SUB_ACCOUNT, resolveReach } from "@/lib/api/agent-reach";
import { recordAgentWrite } from "@/lib/api/agent-audit";
import type { HeldEnrolment, HoldFailure } from "@/lib/workflows/agent-hold";

export {
  AGENCY_AGENT_CALLABLE,
  agencyAgentCallable,
  agentCallable,
  isAgentReadTool,
  isAgentWriteTool,
} from "@/lib/api/agent-tools-listing";
import {
  CapabilityUserError,
  CapabilityWriteRefused,
  getCapability,
  type AiSuiteCapability,
} from "@/lib/ai-suite/capabilities";
import { agencyAgentCallable, agentCallable } from "@/lib/api/agent-tools-listing";
import {
  createProposal,
  OUTCOME_UNKNOWN_MESSAGE,
  type ProposalStatus,
} from "@/lib/server/agent-proposals";
import {
  assertPinnedWhenOutbound,
  normalizePreview,
  proposalTooLarge,
} from "@/lib/server/agent-proposals-encoding";

export type AgentDispatchResult = (
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
  | { ok: false; code: string; httpStatus: number; message: string }
) & {
  /** Agency key only: the sub-account the call was scoped to, set once
   *  `resolveReach` let it through — every outcome after that, a refusal
   *  included, logs there. Absent for agency-level calls and refusals at
   *  or before reach, which log under the agency. */
  scopedTo?: string;
};

const refuse = (
  code: string,
  httpStatus: number,
  message: string
): AgentDispatchResult => ({ ok: false, code, httpStatus, message });

/** One response for every name the agent may not call, so it cannot probe
 *  which chat-only or agency-level names exist. */
const notAvailable = (): AgentDispatchResult =>
  refuse("not_available", 404, "No such tool is available to this key.");

/** One response for every sub-account an agency key may not act in. */
const noSuchSubAccount = (): AgentDispatchResult => refuse("not_found", 404, NO_SUCH_SUB_ACCOUNT);


/**
 * The ONE choke point for agent tool calls (MCP and REST). Every refusal
 * runs before any capability code: scope, test mode, the agency's Agent API
 * gate (read fresh on every call, so switching it off makes keys inert
 * immediately), then surface / level / role. An agency key calls an
 * AGENCY_AGENT_CALLABLE capability as itself, or a sub-account capability in
 * the `subAccountId` it names — once `resolveReach` lets it through, the
 * call runs the sub-account pipeline below unchanged, scoped to that target.
 * A capability with an `approval` class is never executed here: it becomes
 * an `agentProposals` row a person approves. Nothing thrown anywhere in the
 * pipeline escapes: a CapabilityUserError is a 400 with its message, anything
 * else a generic 500.
 */
export async function dispatchAgentTool(
  auth: ApiAuthContext | AgencyApiAuthContext,
  name: string,
  rawArgs: unknown
): Promise<AgentDispatchResult> {
  try {
    return await dispatch(auth, name, rawArgs);
  } catch (err) {
    return failure(name, err);
  }
}

/** A throw from the pipeline, as the refusal described above. */
function failure(name: string, err: unknown): AgentDispatchResult {
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

async function dispatch(
  auth: ApiAuthContext | AgencyApiAuthContext,
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
  if (auth.level === "agency") return dispatchForAgencyKey(auth, name, rawArgs);
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

  // Validators would drop it silently and run the call in the key's own
  // sub-account, not the one the agent named.
  if (
    rawArgs &&
    typeof rawArgs === "object" &&
    "subAccountId" in rawArgs &&
    (rawArgs as { subAccountId: unknown }).subAccountId !== auth.subAccountId
  ) {
    const message = "This key belongs to one sub-account and cannot act in another. Omit subAccountId.";
    return refuse("wrong_sub_account", 400, message);
  }

  const cap = getCapability(name);
  if (!cap || !agentCallable(cap)) return notAvailable();
  return runInSubAccount(auth, cap, rawArgs);
}

async function dispatchForAgencyKey(
  auth: AgencyApiAuthContext,
  name: string,
  rawArgs: unknown
): Promise<AgentDispatchResult> {
  // The agency's kill switch, read fresh on every call (auth reads it once
  // per HTTP request; an MCP batch makes several calls).
  const agency = await getAdminDb().doc(`agencies/${auth.agencyId}`).get();
  if (agency.data()?.agentApiEnabled !== true) {
    const message = "The Agent API is switched off for this agency. The agency owner can switch it on in Agency settings.";
    return refuse("agent_api_disabled", 403, message);
  }
  const cap = getCapability(name);
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

  if (cap && agencyAgentCallable(cap)) {
    // No proposal path at the agency level yet: only plain reads run here.
    if (!cap.readonly || cap.approval || cap.approvalFor) return notAvailable();
    // Reach runs on ANY subAccountId an agency-level call carries.
    if ("subAccountId" in args && !(await resolveReach(auth.agencyId, args.subAccountId))) {
      return noSuchSubAccount();
    }
    const validated = cap.validate(rawArgs);
    if (!validated.ok) return refuse("invalid_args", 400, validated.error);
    // A validator that rewrote the id (case, "#1011") would run on one reach never checked.
    if ("subAccountId" in validated.args && validated.args.subAccountId !== args.subAccountId) return noSuchSubAccount();
    const result = await cap.execute(buildAgencyAgentContext(auth), validated.args);
    return {
      ok: true,
      resultText: result.resultText,
      args: validated.args,
      ...(result.truncated ? { truncated: true as const } : {}),
    };
  }

  if (!cap || !agentCallable(cap)) return notAvailable();
  // Popped before validation: the target is the scope, never a capability arg.
  const { subAccountId, ...rest } = args;
  const target = await resolveReach(auth.agencyId, subAccountId);
  if (!target) return noSuchSubAccount();
  const scoped: ApiAuthContext = { ...auth, level: "sub-account", subAccountId: target, keyLevel: "agency" };
  // Past reach every outcome — a throw included — belongs to the target.
  const result = await runInSubAccount(scoped, cap, rest).catch((err: unknown) => failure(cap.name, err));
  return { ...result, scopedTo: target };
}

/** The sub-account pipeline: validate, then queue for approval or execute. */
async function runInSubAccount(
  auth: ApiAuthContext,
  cap: AiSuiteCapability,
  rawArgs: unknown
): Promise<AgentDispatchResult> {
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
    if (proposalTooLarge(validated.args, reviewed)) {
      return refuse(
        "proposal_too_large",
        400,
        cap.proposalTooLargeMessage ?? "This action is too large to queue for approval. Split it into smaller changes."
      );
    }
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

  let result: Awaited<ReturnType<AiSuiteCapability["execute"]>>;
  try {
    result = await cap.execute(ctx, validated.args);
  } catch (err) {
    // Refused, but something was written: audit it like any agent write.
    if (err instanceof CapabilityWriteRefused) await recordAgentWrite(auth, cap.name, validated.args, err.ref);
    throw err;
  }
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

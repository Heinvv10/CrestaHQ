import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { ApiAuthContext } from "@/lib/api/auth";
import { buildAgentContext } from "@/lib/api/agent-context";
import {
  availableOn,
  CapabilityUserError,
  getCapability,
  roleSatisfies,
} from "@/lib/ai-suite/capabilities";
import {
  createProposal,
  OUTCOME_UNKNOWN_MESSAGE,
  type ProposalStatus,
} from "@/lib/server/agent-proposals";

export type AgentDispatchResult =
  | { ok: true; resultText: string; ref?: { kind: string; id: string } }
  | {
      ok: true;
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
  if (!cap || cap.level !== "sub-account" || !availableOn(cap, "agent")) {
    return notAvailable();
  }
  if (
    !roleSatisfies(cap.requiredRole, {
      agencyRoleIsOwner: false,
      subAccountRole: "admin",
    })
  ) {
    return notAvailable();
  }

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
  if (cap.approval) {
    // The approver sees `preview` verbatim; a queued action without one
    // could not be judged, so it is a registry bug, not a proposal.
    if (!cap.preview) throw new Error(`${cap.name} has approval but no preview`);
    const created = await createProposal({
      agencyId: auth.agencyId,
      subAccountId: auth.subAccountId,
      keyId: auth.keyId,
      keyPrefix: auth.keyPrefix,
      capability: cap.name,
      approval: cap.approval,
      args: validated.args,
      summary: cap.summarize(validated.args),
      preview: await cap.preview(ctx, validated.args),
      contactId: cap.approvalContactId
        ? cap.approvalContactId(validated.args)
        : typeof validated.args.contactId === "string"
          ? validated.args.contactId
          : null,
    });
    if (!created.ok) {
      return created.code === "key_revoked"
        ? refuse("key_revoked", 401, "This API key has been revoked.")
        : refuse("outcome_unknown", 409, OUTCOME_UNKNOWN_MESSAGE);
    }
    const { id, status, summary, preview } = created;
    return { ok: true, proposal: { id, status, summary, preview } };
  }

  const result = await cap.execute(ctx, validated.args);
  return {
    ok: true,
    resultText: result.resultText,
    ...(result.ref ? { ref: result.ref } : {}),
  };
}

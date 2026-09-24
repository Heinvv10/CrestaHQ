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

export type AgentDispatchResult =
  | { ok: true; resultText: string; ref?: { kind: string; id: string } }
  | { ok: false; code: string; httpStatus: number; message: string };

const refuse = (
  code: string,
  httpStatus: number,
  message: string
): AgentDispatchResult => ({ ok: false, code, httpStatus, message });

/** One response for every name the agent may not call, so it cannot probe
 *  which chat-only or agency-level names exist. */
const NOT_AVAILABLE = refuse(
  "not_available",
  404,
  "No such tool is available to this key."
);

/**
 * The ONE choke point for agent tool calls (MCP and REST). Every refusal
 * runs before any capability code: scope, test mode, the agency's Agent API
 * gate (read fresh on every call, so switching it off makes keys inert
 * immediately), then surface / level / role. A capability with an
 * `approval` class is never executed here.
 */
export async function dispatchAgentTool(
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
    return NOT_AVAILABLE;
  }
  if (
    !roleSatisfies(cap.requiredRole, {
      agencyRoleIsOwner: false,
      subAccountRole: "admin",
    })
  ) {
    return NOT_AVAILABLE;
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

  if (cap.approval) {
    return refuse(
      "not_yet_available",
      501,
      "This tool needs human approval, which is not available yet."
    );
  }

  try {
    const result = await cap.execute(buildAgentContext(auth), validated.args);
    return {
      ok: true,
      resultText: result.resultText,
      ...(result.ref ? { ref: result.ref } : {}),
    };
  } catch (err) {
    if (err instanceof CapabilityUserError) {
      return refuse("invalid_request", 400, err.message);
    }
    console.error(`[agent-dispatch] ${cap.name} failed:`, err);
    return refuse("internal_error", 500, "The tool failed to run.");
  }
}

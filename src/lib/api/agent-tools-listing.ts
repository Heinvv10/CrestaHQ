import "server-only";

import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";
import {
  AI_SUITE_CAPABILITIES,
  availableOn,
  getCapability,
  roleSatisfies,
  type AiSuiteCapability,
} from "@/lib/ai-suite/capabilities";

/**
 * The agency-level capabilities an agency key may call: an explicit named
 * set, never derived from `availableOn` — a capability joins it in the PR
 * that gives it its approval class.
 */
export const AGENCY_AGENT_CALLABLE: ReadonlySet<string> = new Set([
  "list_sub_accounts",
  "sub_account_stats",
  "create_sub_account",
  "set_sub_account_gate",
  "list_snapshots",
  "apply_snapshot",
  "list_billing_plans",
  "create_billing_plan",
  "assign_billing_plan",
  "create_one_time_charge",
]);

/** The Agency Assistant's "in a named sub-account" variants: chat-only,
 *  refused by name on both levels (an agency key targets with
 *  `subAccountId` on the base tool instead). */
const isInSubAccountVariant = (cap: AiSuiteCapability) => cap.name.endsWith("_in_sub_account");

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
    !isInSubAccountVariant(cap) &&
    availableOn(cap, "agent") &&
    cap.approval !== "workflow_enrolment" &&
    roleSatisfies(cap.requiredRole, { agencyRoleIsOwner: false, subAccountRole: "admin" })
  );
}

/** Whether an agency key may call `cap` at the agency level (a chat-only
 *  capability never, even named in the set). */
export function agencyAgentCallable(cap: AiSuiteCapability): boolean {
  return (
    cap.level === "agency" &&
    AGENCY_AGENT_CALLABLE.has(cap.name) &&
    !isInSubAccountVariant(cap) &&
    availableOn(cap, "agent")
  );
}

/** A write tool the key may call: the only kind whose bodies a request log
 *  keeps. A read's args and result are PII; an unknown or non-callable
 *  name's args may be too (a misspelled read), so neither is logged. */
export function isAgentWriteTool(name: string): boolean {
  const cap = getCapability(name);
  return !!cap && (agentCallable(cap) || agencyAgentCallable(cap)) && cap.readonly !== true;
}

/** A read tool a key may call, at either level — so an agency-level read is
 *  never cached as an idempotent reply either. Anything else — including a chat-only or
 *  unknown name — is treated alike, so the REST and MCP hooks can't reveal
 *  which exist. */
export function isAgentReadTool(name: string): boolean {
  const cap = getCapability(name);
  return !!cap && (agentCallable(cap) || agencyAgentCallable(cap)) && cap.readonly === true;
}

/** The `subAccountId` an agency key names on every sub-account tool. */
const SUB_ACCOUNT_ID_PARAM = {
  type: "string",
  description: "The sub-account to act in, exactly as returned by list_sub_accounts.",
};

/**
 * The tools a key may call, with the schema of their args — the ONE list
 * behind GET /api/v1/tools and MCP `tools/list`. A sub-account key gets the
 * v1 set as-is; an agency key gets the agency-level set plus every
 * sub-account tool, whose schema gains a required `subAccountId`.
 */
export function agentToolsFor(
  auth: ApiAuthContext | AgencyApiAuthContext,
): Array<{ cap: AiSuiteCapability; parameters: unknown }> {
  if (auth.keyLevel !== "agency") {
    return AI_SUITE_CAPABILITIES.filter(agentCallable).map((cap) => ({ cap, parameters: cap.parameters }));
  }
  return AI_SUITE_CAPABILITIES.filter((c) => agencyAgentCallable(c) || agentCallable(c)).map((cap) => {
    if (cap.level === "agency") return { cap, parameters: cap.parameters };
    const p = cap.parameters as { properties?: Record<string, unknown>; required?: string[] };
    return {
      cap,
      parameters: {
        ...p,
        properties: { subAccountId: SUB_ACCOUNT_ID_PARAM, ...(p.properties ?? {}) },
        required: ["subAccountId", ...(p.required ?? [])],
      },
    };
  });
}

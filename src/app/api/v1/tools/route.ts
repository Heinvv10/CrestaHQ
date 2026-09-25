import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  AI_SUITE_CAPABILITIES,
  availableOn,
  roleSatisfies,
} from "@/lib/ai-suite/capabilities";

/**
 * GET /api/v1/tools — the capabilities an agent key may call, with the JSON
 * Schema of their args (AGENT_API_V1_PLAN.md, PR4). The same filter as
 * dispatchAgentTool: sub-account level, surfaced to agents, runnable as a
 * sub-account admin, and never the engine-only workflow_enrolment class.
 * The Agent API gate is read fresh on every request.
 */
export const GET = withApiAuth(
  async ({ ctx }) => {
    const sub = await getAdminDb().doc(`subAccounts/${ctx.subAccountId}`).get();
    if (sub.data()?.agentApiEnabledByAgency !== true) {
      return apiError(
        ctx,
        "permission_error",
        "agent_api_disabled",
        "Agent API access has been disabled for this sub-account by your agency administrator.",
      );
    }
    const tools = AI_SUITE_CAPABILITIES.filter(
      (c) =>
        c.level === "sub-account" &&
        availableOn(c, "agent") &&
        c.approval !== "workflow_enrolment" &&
        roleSatisfies(c.requiredRole, { agencyRoleIsOwner: false, subAccountRole: "admin" }),
    ).map((c) => ({
      name: c.name,
      description: c.description,
      parameters: c.parameters,
      readOnly: c.readonly === true,
      ...(c.approval ? { approval: c.approval } : {}),
    }));
    return apiOk(ctx, { tools });
  },
  { requireScope: "agent" },
);

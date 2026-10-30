import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { apiOk } from "@/lib/api/responses";
import { agentToolsFor } from "@/lib/api/agent-tools-listing";
import { agentPrecheck } from "@/lib/api/agent-precheck";

/**
 * GET /api/v1/tools — the capabilities an agent key may call, with the JSON
 * Schema of their args (AGENT_API_V1_PLAN.md, PR4): exactly the set
 * dispatchAgentTool accepts (`agentToolsFor`, shared with MCP tools/list). Test-mode keys and a
 * sub-account whose Agent API gate is off (read fresh) are refused first. An
 * agency key gets every sub-account tool with a required `subAccountId`.
 */
export const GET = withApiAuth(
  async ({ ctx }) => {
    const tools = agentToolsFor(ctx).map(({ cap: c, parameters }) => ({
      name: c.name,
      description: c.description,
      parameters,
      readOnly: c.readonly === true,
      ...(c.approval
        ? { approval: c.approval }
        : c.approvalHint
          ? { approval: c.approvalHint.approval, approvalWhen: c.approvalHint.when }
          : {}),
    }));
    return apiOk(ctx, { tools });
  },
  { requireScope: "agent", precheck: agentPrecheck, allowAgencyKey: true },
);

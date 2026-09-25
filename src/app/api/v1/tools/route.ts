import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { apiOk } from "@/lib/api/responses";
import { agentCallable } from "@/lib/api/agent-dispatch";
import { agentPrecheck } from "@/lib/api/agent-precheck";
import { AI_SUITE_CAPABILITIES } from "@/lib/ai-suite/capabilities";

/**
 * GET /api/v1/tools — the capabilities an agent key may call, with the JSON
 * Schema of their args (AGENT_API_V1_PLAN.md, PR4): exactly the set
 * dispatchAgentTool accepts (`agentCallable`). Test-mode keys and a
 * sub-account whose Agent API gate is off (read fresh) are refused first.
 */
export const GET = withApiAuth(
  async ({ ctx }) => {
    const tools = AI_SUITE_CAPABILITIES.filter(agentCallable).map((c) => ({
      name: c.name,
      description: c.description,
      parameters: c.parameters,
      readOnly: c.readonly === true,
      ...(c.approval
        ? { approval: c.approval }
        : c.approvalHint
          ? { approval: c.approvalHint.approval, approvalWhen: c.approvalHint.when }
          : {}),
    }));
    return apiOk(ctx, { tools });
  },
  { requireScope: "agent", precheck: agentPrecheck },
);

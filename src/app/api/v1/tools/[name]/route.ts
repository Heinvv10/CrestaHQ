import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { CALL_AGENT_TOOL_OPTIONS, callAgentTool } from "@/lib/api/agent-tools-call";

/** POST /api/v1/tools/{name} — call one agent tool (see `callAgentTool`). */
export const POST = withApiAuth<{ name: string }>(callAgentTool, CALL_AGENT_TOOL_OPTIONS);

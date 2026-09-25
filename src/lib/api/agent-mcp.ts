import "server-only";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ApiAuthContext } from "@/lib/api/auth";
import { checkAndCount } from "@/lib/api/rate-limit";
import { captureRequestLog } from "@/lib/api/logs";
import { agentCallable, dispatchAgentTool, isAgentReadTool } from "@/lib/api/agent-dispatch";
import { AI_SUITE_CAPABILITIES } from "@/lib/ai-suite/capabilities";

/**
 * The MCP face of the Agent API (AGENT_API_V1_PLAN.md, PR5): a low-level
 * `Server` built per HTTP request over a STATELESS web-standard Streamable
 * HTTP transport. `tools/list` is the same set as GET /api/v1/tools
 * (`agentCallable`); every `tools/call` takes its own rate-limit token — so
 * a JSON-RPC batch can't turn one HTTP request into N writes — then runs
 * dispatchAgentTool and writes one request log (`/api/mcp#<name>`); the
 * route charges each request one more token up front. A read
 * tool's args and result stay out of that log, as on REST. No idempotency
 * on MCP in v1.
 */

/** The tools an agent key may call, as MCP tool descriptors. */
export function agentMcpTools(): Tool[] {
  return AI_SUITE_CAPABILITIES.filter(agentCallable).map((c) => ({
    name: c.name,
    description: c.description,
    inputSchema: c.parameters as Tool["inputSchema"],
    ...(c.readonly ? { annotations: { readOnlyHint: true } } : {}),
    ...(c.approval ? { _meta: { approval: c.approval } } : {}),
  }));
}

const refusal = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: `${code}: ${message}` }],
  structuredContent: { error: { code, message } },
});

/** A caller-supplied name, safe in a log line: control and line-separator
 *  characters become "?", and it is capped at 80. */
const logSafe = (name: unknown) =>
  [...String(name).slice(0, 80)]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 ? "?" : ch;
    })
    .join("");

/** One tools/call: rate limit, dispatch, map to an MCP result, log. */
async function callTool(
  auth: ApiAuthContext,
  request: Request,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const start = Date.now();
  let status: number;
  let body: unknown;
  let errorCode: string | null = null;
  let result: CallToolResult;

  const rl = checkAndCount({ keyId: auth.keyId, mode: auth.mode, scope: "agent" });
  if (!rl.ok) {
    [status, errorCode] = [429, "rate_limited"];
    const message = `Too many requests. Retry after ${rl.retryAfterSec}s.`;
    body = { error: { code: errorCode, message } };
    result = refusal(errorCode, message);
  } else {
    const r = await dispatchAgentTool(auth, name, args ?? {});
    if (!r.ok) {
      [status, errorCode] = [r.httpStatus, r.code];
      body = { error: { code: r.code, message: r.message } };
      result = refusal(r.code, r.message);
    } else if ("proposal" in r) {
      const { id, status: proposalStatus, summary, preview } = r.proposal;
      status = 202;
      body = { proposal: { id, status: proposalStatus, summary, preview } };
      result = {
        content: [
          {
            type: "text",
            text: `Queued for human approval as proposal ${id}: ${summary}. It runs only if a person approves it; do not retry.`,
          },
        ],
        structuredContent: { proposal: { id, status: proposalStatus, summary, preview } },
      };
    } else {
      status = 200;
      const extra = {
        ...(r.ref ? { ref: r.ref } : {}),
        ...(r.held ? { held: r.held, holdFailures: r.holdFailures ?? [] } : {}),
      };
      body = { result: r.resultText, ...extra };
      result = {
        content: [
          { type: "text", text: r.resultText },
          ...(r.held ? [{ type: "text" as const, text: JSON.stringify({ held: r.held, holdFailures: r.holdFailures ?? [] }) }] : []),
        ],
        ...(Object.keys(extra).length ? { structuredContent: extra } : {}),
      };
    }
  }

  const read = isAgentReadTool(name);
  void captureRequestLog({
    subAccountId: auth.subAccountId,
    agencyId: auth.agencyId,
    keyId: auth.keyId,
    keyPrefix: auth.keyPrefix,
    mode: auth.mode,
    requestId: auth.requestId,
    method: "POST",
    path: `/api/mcp#${logSafe(name)}`,
    query: "",
    requestHeaders: request.headers,
    requestBody: read ? "" : JSON.stringify(args ?? {}),
    responseStatus: status,
    responseBodyJson: read ? null : body,
    errorCode,
    latencyMs: Date.now() - start,
  });
  return result;
}

/** Serve one MCP HTTP request for an authenticated, prechecked agent key. */
export async function handleMcpRequest(
  auth: ApiAuthContext,
  request: Request,
  parsedBody: unknown,
): Promise<Response> {
  const server = new Server(
    { name: "leadstack", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: agentMcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    callTool(auth, request, req.params.name, req.params.arguments),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}

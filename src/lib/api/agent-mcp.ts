import "server-only";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";
import { checkAndCount } from "@/lib/api/rate-limit";
import { captureRequestLog } from "@/lib/api/logs";
import { dispatchAgentTool, isAgentWriteTool } from "@/lib/api/agent-dispatch";
import { agentToolsFor } from "@/lib/api/agent-tools-listing";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * The MCP face of the Agent API (AGENT_API_V1_PLAN.md, PR5): a low-level
 * `Server` built per HTTP request over a STATELESS web-standard Streamable
 * HTTP transport. `tools/list` is the same set as GET /api/v1/tools
 * (`agentToolsFor`). The route charges each request one token up front,
 * which pays for its first `tools/call`; every further call takes its own —
 * so one call costs one token, as on REST, and a JSON-RPC batch can't turn
 * one HTTP request into N free writes. Each call runs dispatchAgentTool and
 * writes one request log (`/api/mcp#<name>`). Bodies are logged
 * only for a callable write (its validated args, never the raw ones), and
 * per-call rate-limit refusals collapse into ONE log row per HTTP request.
 * Nothing thrown — dispatch, logging, SDK validation — reaches the client
 * as raw error text. No idempotency on MCP in v1. An agency key's call logs
 * under the sub-account it was scoped to only once reach let it through;
 * every other agency-key row lands under the agency.
 */

/** The tools this key may call, as MCP tool descriptors. */
export function agentMcpTools(auth: ApiAuthContext | AgencyApiAuthContext): Tool[] {
  return agentToolsFor(auth).map(({ cap: c, parameters }) => ({
    name: c.name,
    description: c.description,
    inputSchema: parameters as Tool["inputSchema"],
    ...(c.readonly ? { annotations: { readOnlyHint: true } } : {}),
    ...(c.approval
      ? { _meta: { approval: c.approval } }
      : c.approvalHint
        ? { _meta: { approval: c.approvalHint.approval, approvalWhen: c.approvalHint.when } }
        : {}),
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

/** Per-HTTP-request state shared by that request's tool calls. */
interface CallState {
  rateLimited: number;
  /** The request's up-front token also pays for its first call, so one
   *  call costs one token — the same budget as REST. */
  firstCallPaid: boolean;
  /** JSON-RPC ids of this request's tools/call messages. */
  toolCallIds: Set<string>;
}

const INTERNAL = refusal("internal_error", "The tool call failed.");

/** One tools/call: rate limit, dispatch, map to an MCP result, log. Never throws. */
async function callTool(
  auth: ApiAuthContext | AgencyApiAuthContext,
  request: Request,
  state: CallState,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const start = Date.now();
  const prepaid = state.firstCallPaid;
  state.firstCallPaid = false;
  const rl = prepaid
    ? { ok: true as const, retryAfterSec: 0 }
    : checkAndCount({ keyId: auth.keyId, mode: auth.mode, scope: "agent", rateLimitPerMinute: auth.rateLimitPerMinute });
  if (!rl.ok) {
    // Not logged per call: the request writes one summary row (handleMcpRequest).
    state.rateLimited += 1;
    return refusal("rate_limited", `Too many requests. Retry after ${rl.retryAfterSec}s.`);
  }

  let r: Awaited<ReturnType<typeof dispatchAgentTool>>;
  try {
    r = await dispatchAgentTool(auth, name, args ?? {});
  } catch (err) {
    // dispatchAgentTool catches its own errors; this is belt and braces.
    console.error("[api/mcp] dispatch threw", err);
    return INTERNAL;
  }

  let status: number;
  let body: unknown;
  let result: CallToolResult;
  if (!r.ok) {
    status = r.httpStatus;
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
      ...(r.truncated ? { truncated: true } : {}),
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

  // The dispatch has happened (a write may have committed): nothing in the
  // log path may change the result the agent gets back.
  try {
    const bodies = isAgentWriteTool(name);
    log(auth, request, start, {
      subAccountId: auth.subAccountId ?? r.scopedTo ?? null,
      path: `/api/mcp#${logSafe(name)}`,
      requestBody: bodies && r.ok ? stringifyOr(r.args) : "",
      status,
      body: bodies ? body : null,
      errorCode: r.ok ? null : r.code,
    });
  } catch (err) {
    console.error("[api/mcp] request log failed", err);
  }
  return result;
}

/** JSON, or a placeholder when it can't be serialised (cyclic, too deep). */
function stringifyOr(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function log(
  auth: ApiAuthContext | AgencyApiAuthContext,
  request: Request,
  start: number,
  row: {
    /** null: the agency's log (see captureRequestLog). */
    subAccountId: string | null;
    path: string;
    requestBody: string;
    status: number;
    body: unknown;
    errorCode: string | null;
  },
): void {
  // Measured now: the log itself is written after the response.
  const latencyMs = Date.now() - start;
  runAfterResponse(() => captureRequestLog({
    subAccountId: row.subAccountId,
    agencyId: auth.agencyId,
    keyId: auth.keyId,
    keyPrefix: auth.keyPrefix,
    mode: auth.mode,
    requestId: auth.requestId,
    method: "POST",
    path: row.path,
    query: "",
    requestHeaders: request.headers,
    requestBody: row.requestBody,
    responseStatus: row.status,
    responseBodyJson: row.body,
    errorCode: row.errorCode,
    latencyMs,
  }));
}

/** An SDK-produced JSON-RPC error (e.g. a tools/call whose params fail its
 *  schema) carries the raw validation dump; the agent gets a generic one. */
function sanitizeOutgoing(message: JSONRPCMessage, toolCallIds: Set<string>): JSONRPCMessage {
  if (!("error" in message) || message.error.code === ErrorCode.MethodNotFound) return message;
  const error = toolCallIds.has(JSON.stringify(message.id))
    ? { code: ErrorCode.InvalidParams, message: "Invalid tool call: check the tool name and arguments." }
    : { code: ErrorCode.InvalidRequest, message: "Invalid request." };
  return { ...message, error };
}

/** Serve one MCP HTTP request for an authenticated, prechecked agent key. */
export async function handleMcpRequest(
  auth: ApiAuthContext | AgencyApiAuthContext,
  request: Request,
  parsedBody: unknown,
): Promise<Response> {
  const start = Date.now();
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  const state: CallState = {
    rateLimited: 0,
    firstCallPaid: true,
    toolCallIds: new Set(
      messages
        .filter((m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call" && "id" in m)
        .map((m) => JSON.stringify((m as { id: unknown }).id)),
    ),
  };
  const server = new Server(
    { name: "leadstack", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: agentMcpTools(auth) }));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    callTool(auth, request, state, req.params.name, req.params.arguments),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(sanitizeOutgoing(message, state.toolCallIds), options);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
    if (state.rateLimited > 0) {
      log(auth, request, start, {
        subAccountId: auth.subAccountId,
        path: "/api/mcp",
        requestBody: "",
        status: 429,
        body: { rateLimitedCalls: state.rateLimited },
        errorCode: "rate_limited",
      });
    }
  }
}

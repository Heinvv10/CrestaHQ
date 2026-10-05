import "server-only";

import type { NextResponse } from "next/server";
import {
  authenticateApiRequest,
  requireApiScope,
  type AgencyApiAuthContext,
  type ApiAuthContext,
} from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { captureRequestLog } from "@/lib/api/logs";
import { checkAndCount } from "@/lib/api/rate-limit";
import { agentPrecheck } from "@/lib/api/agent-precheck";
import { handleMcpRequest } from "@/lib/api/agent-mcp";
import { MAX_AGENT_BODY_BYTES, readBodyCapped } from "@/lib/api/body-limit";

/**
 * POST /api/mcp — the Agent API over MCP (Streamable HTTP, stateless).
 * Every request: bearer `lsk_` key (authenticateApiRequest), the `agent`
 * scope, then the same precheck as REST (test mode refused, the Agent API
 * gate read fresh). Those refusals are plain HTTP v1 errors, logged as
 * `/api/mcp`; per-call refusals are MCP `isError` results (see agent-mcp).
 * Rate limit: every authenticated request pays one token up front, right
 * after the scope check and before anything else runs (as on REST). That
 * token also covers the request's first tools/call; each further call pays
 * one more (in agent-mcp). So one call costs 1, a 3-call batch 3, and a
 * request that runs nothing still 1 — nothing is free. A batch that repeats a
 * JSON-RPC id is refused whole before any message runs.
 * GET (no server-initiated stream) and DELETE (no sessions) → 405.
 * An agency key is accepted: each call names its `subAccountId`, and the
 * route-level refusals above log under the agency (no target yet).
 */
export async function POST(request: Request): Promise<Response> {
  const start = Date.now();
  const auth = await authenticateApiRequest(request);
  if (auth instanceof Response) return auth;

  const refuse = (response: Response, code: string) => {
    void captureRequestLog({
      subAccountId: auth.subAccountId,
      agencyId: auth.agencyId,
      keyId: auth.keyId,
      keyPrefix: auth.keyPrefix,
      mode: auth.mode,
      requestId: auth.requestId,
      method: "POST",
      path: "/api/mcp",
      query: "",
      requestHeaders: request.headers,
      requestBody: "",
      responseStatus: response.status,
      responseBodyJson: null,
      errorCode: code,
      latencyMs: Date.now() - start,
    });
    return response;
  };

  const scopeErr = requireApiScope(auth, "agent");
  if (scopeErr) return refuse(scopeErr, "insufficient_scope");
  const rl = checkAndCount({ keyId: auth.keyId, mode: auth.mode, scope: "agent" });
  if (!rl.ok) {
    return refuse(
      apiError(auth, "rate_limit_error", "rate_limited", `Too many requests. Retry after ${rl.retryAfterSec}s.`, {
        extraHeaders: {
          "Retry-After": String(rl.retryAfterSec),
          "X-RateLimit-Limit": String(rl.limit ?? 0),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(rl.retryAfterSec),
          "X-RateLimit-Window": rl.window ?? "",
        },
      }),
      "rate_limited",
    );
  }
  let refused: NextResponse | null;
  try {
    refused = await agentPrecheck(auth);
  } catch (err) {
    console.error("[api/mcp] precheck threw", err);
    return refuse(internalError(auth), "internal_error");
  }
  if (refused) {
    const code = await refused
      .clone()
      .json()
      .then((b: { error?: { code?: string } }) => b.error?.code ?? "refused")
      .catch(() => "refused");
    return refuse(refused, code);
  }
  // Read the body here (capped, see body-limit) so a batch can be checked
  // before any message runs; the transport then uses this parse instead of
  // re-reading.
  const raw = await readBodyCapped(request, MAX_AGENT_BODY_BYTES);
  if (raw === null) return refuse(jsonRpcError(413, -32000, "Request body too large."), "body_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return refuse(jsonRpcError(400, -32700, "Parse error: Invalid JSON"), "parse_error");
  if (Array.isArray(parsed) && hasDuplicateRequestId(parsed)) {
    return refuse(jsonRpcError(400, -32600, "Invalid Request: a batch must not repeat a request id."), "duplicate_id");
  }
  try {
    return await handleMcpRequest(auth, request, parsed);
  } catch (err) {
    console.error("[api/mcp] request failed", err);
    return refuse(internalError(auth), "internal_error");
  }
}

const internalError = (auth: ApiAuthContext | AgencyApiAuthContext) =>
  apiError(auth, "internal_error", "internal_error", "Something went wrong on our end. Quote this request_id in support.");

/** Two requests (messages with a method and an id) sharing one id. */
function hasDuplicateRequestId(batch: unknown[]): boolean {
  const seen = new Set<string>();
  for (const m of batch) {
    if (!m || typeof m !== "object" || !("method" in m) || !("id" in m)) continue;
    const id = JSON.stringify((m as { id: unknown }).id);
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

const methodNotAllowed = () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;

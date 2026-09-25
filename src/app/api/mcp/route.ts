import "server-only";

import type { NextResponse } from "next/server";
import { authenticateApiRequest, requireApiScope, type ApiAuthContext } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { captureRequestLog } from "@/lib/api/logs";
import { checkAndCount } from "@/lib/api/rate-limit";
import { agentPrecheck } from "@/lib/api/agent-precheck";
import { handleMcpRequest } from "@/lib/api/agent-mcp";

/**
 * POST /api/mcp — the Agent API over MCP (Streamable HTTP, stateless).
 * Every request: bearer `lsk_` key (authenticateApiRequest), the `agent`
 * scope, then the same precheck as REST (test mode refused, the Agent API
 * gate read fresh). Those refusals are plain HTTP v1 errors, logged as
 * `/api/mcp`; per-call refusals are MCP `isError` results (see agent-mcp).
 * Rate limit: each tools/call takes one token (in agent-mcp); a request
 * with no tools/call at all (initialize, tools/list, notifications) takes
 * exactly one, here — so nothing on this route is unthrottled.
 * GET (no server-initiated stream) and DELETE (no sessions) → 405.
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
  // Read the body here (capped like the transport's own read) so the
  // token decision is made before any message runs; the transport then
  // uses this parse instead of re-reading.
  const raw = await readCappedBody(request);
  if (raw === null) return refuse(jsonRpcError(413, -32000, "Request body too large."), "body_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const hasToolCall = messages.some(
    (m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call",
  );
  if (!hasToolCall) {
    const rl = checkAndCount({ keyId: auth.keyId, mode: auth.mode, scope: "agent" });
    if (!rl.ok) {
      return refuse(
        apiError(auth, "rate_limit_error", "rate_limited", `Too many requests. Retry after ${rl.retryAfterSec}s.`, {
          extraHeaders: { "Retry-After": String(rl.retryAfterSec) },
        }),
        "rate_limited",
      );
    }
  }
  if (parsed === undefined) return refuse(jsonRpcError(400, -32700, "Parse error: Invalid JSON"), "parse_error");
  try {
    return await handleMcpRequest(auth, request, parsed);
  } catch (err) {
    console.error("[api/mcp] request failed", err);
    return refuse(internalError(auth), "internal_error");
  }
}

const internalError = (auth: ApiAuthContext) =>
  apiError(auth, "internal_error", "internal_error", "Something went wrong on our end. Quote this request_id in support.");

/** The transport's default body bound (4 MiB). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The body as text, or null past MAX_BODY_BYTES (read no further). */
async function readCappedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

const methodNotAllowed = () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;

import "server-only";

import type { NextResponse } from "next/server";
import { authenticateApiRequest, requireApiScope, type ApiAuthContext } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { captureRequestLog } from "@/lib/api/logs";
import { agentPrecheck } from "@/lib/api/agent-precheck";
import { handleMcpRequest } from "@/lib/api/agent-mcp";

/**
 * POST /api/mcp — the Agent API over MCP (Streamable HTTP, stateless).
 * Every request: bearer `lsk_` key (authenticateApiRequest), the `agent`
 * scope, then the same precheck as REST (test mode refused, the Agent API
 * gate read fresh). Those refusals are plain HTTP v1 errors, logged as
 * `/api/mcp`; per-call refusals are MCP `isError` results (see agent-mcp).
 * GET (no server-initiated stream) and DELETE (no sessions) → 405.
 */
export async function POST(request: Request): Promise<Response> {
  const start = Date.now();
  const auth = await authenticateApiRequest(request);
  if (auth instanceof Response) return auth;

  const refuse = (response: NextResponse, code: string) => {
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
  try {
    return await handleMcpRequest(auth, request);
  } catch (err) {
    console.error("[api/mcp] request failed", err);
    return refuse(internalError(auth), "internal_error");
  }
}

const internalError = (auth: ApiAuthContext) =>
  apiError(auth, "internal_error", "internal_error", "Something went wrong on our end. Quote this request_id in support.");

const methodNotAllowed = () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;

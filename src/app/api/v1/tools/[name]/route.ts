import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk, type ErrorType } from "@/lib/api/responses";
import { dispatchAgentTool } from "@/lib/api/agent-dispatch";
import { toolLogResponseBody } from "@/lib/api/agent-audit";
import { getCapability } from "@/lib/ai-suite/capabilities";

const TYPE_FOR_STATUS: Record<number, ErrorType> = {
  400: "invalid_request",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found",
  409: "invalid_request",
  429: "rate_limit_error",
};

/**
 * POST /api/v1/tools/{name} — call one agent tool; the JSON body is its
 * args. Everything runs through dispatchAgentTool (scope, gate, surface,
 * role, validate, approval). A write returns 200 `{result, ref?, held?,
 * holdFailures?}`; an approval capability returns 202 `{proposal}` — its id,
 * status, summary and preview, never `pinned` or `rev`; a refusal returns
 * its status with the v1 error body. An unknown name is the same 404 as a
 * tool this key may not call. `Idempotency-Key` is honoured (withApiAuth),
 * and a read tool's result is kept out of the request log.
 */
export const POST = withApiAuth<{ name: string }>(
  async ({ ctx, params, body }) => {
    const r = await dispatchAgentTool(ctx, params.name, body ?? {});
    if (!r.ok) {
      return apiError(ctx, TYPE_FOR_STATUS[r.httpStatus] ?? "internal_error", r.code, r.message, {
        status: r.httpStatus,
      });
    }
    if ("proposal" in r) {
      const { id, status, summary, preview } = r.proposal;
      return apiOk(ctx, { proposal: { id, status, summary, preview } }, { status: 202 });
    }
    return apiOk(ctx, {
      result: r.resultText,
      ...(r.ref ? { ref: r.ref } : {}),
      ...(r.held ? { held: r.held, holdFailures: r.holdFailures ?? [] } : {}),
    });
  },
  {
    requireScope: "agent",
    logResponseBody: ({ name }, responseBody) =>
      toolLogResponseBody(getCapability(name) ?? { readonly: false }, responseBody),
  },
);

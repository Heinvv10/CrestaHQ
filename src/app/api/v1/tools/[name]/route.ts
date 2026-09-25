import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk, type ErrorType } from "@/lib/api/responses";
import { dispatchAgentTool, isAgentReadTool, isAgentWriteTool } from "@/lib/api/agent-dispatch";
import { agentPrecheck } from "@/lib/api/agent-precheck";

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
 * tool this key may not call. `Idempotency-Key` is honoured (withApiAuth)
 * for writes and proposals; a read tool ignores it — reads are idempotent,
 * and caching one would persist its result. The request log keeps bodies
 * only for a write tool the key may call — never a read's, nor an unknown
 * name's. Test mode and the
 * Agent API gate are checked before any cached reply (`agentPrecheck`).
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
      ...(r.truncated ? { truncated: true } : {}),
      ...(r.held ? { held: r.held, holdFailures: r.holdFailures ?? [] } : {}),
    });
  },
  {
    requireScope: "agent",
    precheck: agentPrecheck,
    // Bodies are kept only for a callable write: a read's are PII, and so
    // may be an unknown name's (a misspelled read).
    redactLog: ({ name }) => {
      const redact = !isAgentWriteTool(name);
      return { requestBody: redact, responseBody: redact };
    },
    // Reads never take part. Otherwise only real outcomes are stored — a
    // write (200), a proposal (202), or outcome_unknown (409); a refusal
    // (gate off, test mode, not available, bad args) must not replay forever.
    cacheIdempotently: ({ name }, outcome) =>
      !isAgentReadTool(name) &&
      (!outcome ||
        outcome.status === 200 ||
        outcome.status === 202 ||
        (outcome.status === 409 &&
          (outcome.body as { error?: { code?: string } } | null)?.error?.code === "outcome_unknown")),
  },
);

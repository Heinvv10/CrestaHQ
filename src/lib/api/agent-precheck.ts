import "server-only";

import type { NextResponse } from "next/server";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { getAdminDb } from "@/lib/firebase/admin";
import { NO_SUCH_SUB_ACCOUNT, resolveReach } from "@/lib/api/agent-reach";

/**
 * The agent tools routes' `precheck` (withApiAuth): refuse a test-mode key
 * and a sub-account whose Agent API gate is off — read fresh — BEFORE the
 * idempotency lookup, so a cached reply can't outlive a gate switched off
 * and a refusal is never cached. For an agency key the same holds for the
 * `subAccountId` in the parsed body: `resolveReach` runs on it here. Same
 * codes as dispatchAgentTool, which keeps its own checks.
 */
export async function agentPrecheck(
  ctx: ApiAuthContext | AgencyApiAuthContext,
  body?: unknown,
): Promise<NextResponse | null> {
  if (ctx.mode === "test") {
    return apiError(ctx, "invalid_request", "test_mode_unsupported", "Agent tools run on live keys only.");
  }
  if (ctx.level === "agency") {
    const target =
      body && typeof body === "object" && "subAccountId" in body
        ? (body as { subAccountId: unknown }).subAccountId
        : undefined;
    if (target !== undefined && !(await resolveReach(ctx.agencyId, target))) {
      return apiError(ctx, "not_found", "not_found", NO_SUCH_SUB_ACCOUNT);
    }
    return null;
  }
  const sub = await getAdminDb().doc(`subAccounts/${ctx.subAccountId}`).get();
  if (sub.data()?.agentApiEnabledByAgency !== true) {
    return apiError(
      ctx,
      "permission_error",
      "agent_api_disabled",
      "Agent API access has been disabled for this sub-account by your agency administrator.",
    );
  }
  return null;
}

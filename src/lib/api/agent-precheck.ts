import "server-only";

import type { NextResponse } from "next/server";
import type { ApiAuthContext } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * The agent tools routes' `precheck` (withApiAuth): refuse a test-mode key
 * and a sub-account whose Agent API gate is off — read fresh — BEFORE the
 * idempotency lookup, so a cached reply can't outlive a gate switched off
 * and a refusal is never cached. Same codes as dispatchAgentTool, which
 * keeps its own checks.
 */
export async function agentPrecheck(ctx: ApiAuthContext): Promise<NextResponse | null> {
  if (ctx.mode === "test") {
    return apiError(ctx, "invalid_request", "test_mode_unsupported", "Agent tools run on live keys only.");
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

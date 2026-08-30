import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { aiIsConfigured, defaultAiModel } from "@/lib/comms/ai/openrouter";

/**
 * Read-only view of the deployment-wide AI model config for the agency settings
 * page. Owner-gated. Returns the effective default OpenRouter model (the one AI
 * Agents use when a channel has no per-sub-account override) plus whether it
 * comes from the AI_REPLIES_DEFAULT_MODEL override or the built-in default.
 * Exposes no secret — just the model id + booleans.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    configured: aiIsConfigured(),
    model: defaultAiModel(),
    isOverride: !!process.env.AI_REPLIES_DEFAULT_MODEL?.trim(),
  });
}

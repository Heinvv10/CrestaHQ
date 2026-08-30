import "server-only";

import { NextResponse } from "next/server";
import { requireSetupEnabled } from "@/lib/setup/guard";
import { vercelConfigured, triggerRedeploy } from "@/lib/vercel/client";

/**
 * Fire the Vercel deploy hook so freshly-written env vars take effect. Separate
 * from /env so the caller batches all key writes first, then redeploys once.
 * Owner + formEnabled enforced by requireSetupEnabled; capability checked here.
 */
export async function POST(request: Request) {
  const auth = await requireSetupEnabled(request);
  if (auth instanceof NextResponse) return auth;

  if (!vercelConfigured()) {
    return NextResponse.json(
      { error: "Vercel is not configured on this deployment." },
      { status: 503 },
    );
  }

  try {
    const result = await triggerRedeploy();
    console.info("[agency/setup/redeploy] triggered", result.id ?? "(no id)");
    return NextResponse.json({ ok: true, deploymentId: result.id ?? null });
  } catch (e) {
    console.error("[agency/setup/redeploy] failed", (e as Error).message);
    return NextResponse.json(
      { error: `Redeploy failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

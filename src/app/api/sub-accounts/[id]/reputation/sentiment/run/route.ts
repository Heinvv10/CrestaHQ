import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { reviewsAiConfigured } from "@/lib/reputation/ai/mode";
import { classifyPendingSentiment } from "@/lib/reputation/sentiment";
import { afterResponse } from "@/lib/reputation/sentiment-after";
import { startManualSentiment } from "@/lib/reputation/sentiment-lease";

/**
 * "Analyse now" — POST /api/sub-accounts/[id]/reputation/sentiment/run.
 * Sub-account admin only; needs the agency's Google gate AND its Reviews AI
 * gate and a selected listing. Takes the classifier's lease and the 1/min
 * slot together (a press refused as busy does not burn the cooldown), answers
 * 202 `{started, aiConfigured}` at once, and classifies AFTER the response —
 * the Overview polls for the result. Nothing unchanged is sent to the AI again.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {};
  if (sub.googleEnabledByAgency !== true) {
    return gbpRefusal(403, "gate_off", "Google reviews are not enabled for this sub-account.");
  }
  if (sub.reviewsAiEnabledByAgency !== true) {
    return gbpRefusal(403, "gate_off", "Reviews AI is off for this sub-account — your agency can switch it on.");
  }
  if (!sub.googleListing?.locationName) {
    return gbpRefusal(409, "no_listing", "No Google listing is selected, so there are no reviews to analyse.");
  }
  const runId = randomUUID();
  const start = await startManualSentiment(id, runId, Date.now());
  if (!start.ok) {
    return start.reason === "busy"
      ? gbpRefusal(409, "busy", "An analysis is already running — the counts update when it finishes.")
      : gbpRefusal(409, "too_soon", "Reviews were analysed less than a minute ago — try again shortly.");
  }
  afterResponse(() => classifyPendingSentiment(id, { heldRunId: runId }));
  return NextResponse.json({ started: true, aiConfigured: reviewsAiConfigured() }, { status: 202 });
}

import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { claimSentimentManualSlot, classifyPendingSentiment } from "@/lib/reputation/sentiment";

/**
 * "Analyse now" — POST /api/sub-accounts/[id]/reputation/sentiment/run.
 * Sub-account admin only; needs the agency's Google gate AND its Reviews AI
 * gate; at most once a minute per sub-account (409 `too_soon`). Runs the
 * same classification every sync runs, inline, and answers with its counts.
 * Nothing already labelled (and unchanged) is sent to the AI again.
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
  if (!(await claimSentimentManualSlot(id, new Date()))) {
    return gbpRefusal(409, "too_soon", "Reviews were analysed less than a minute ago — try again shortly.");
  }
  const outcome = await classifyPendingSentiment(id);
  return NextResponse.json({ outcome });
}

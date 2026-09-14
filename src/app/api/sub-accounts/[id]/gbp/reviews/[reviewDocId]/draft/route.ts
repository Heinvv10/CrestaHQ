import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { loadReplyTarget } from "@/lib/gbp/reply";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { ReviewsAiFakeRefusedError, reviewsAiConfigured } from "@/lib/reputation/ai/mode";
import { getReviewsAiFor } from "@/lib/reputation/ai/select";
import { beginDraftCall, checkDraftRate, draftInputFor } from "@/lib/reputation/draft";

/**
 * POST /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/draft → `{draft}` —
 * an AI reply DRAFT for the admin to edit in the composer (SP5 c). It posts
 * NOTHING: this route never reaches putReply / deleteReply; the only poster
 * is POST …/reply on the admin's click (lib/gbp/reply.ts). No draft text is
 * stored or logged.
 *
 * Sub-account admin only (like the reply), the agency's Google gate (403
 * `gate_off`) AND Reviews AI gate (403 `ai_gate_off`), an active cached
 * review of the current listing (the reply route's lookup — else 404), Reviews
 * AI configured here (503 `ai_not_configured`), 10 drafts a minute per user
 * (429 `rate_limited`, Retry-After), the shared daily AI cap (429
 * `daily_cap`). An AI failure is 424 `draft_failed` (not 502: the edge
 * replaces 502 bodies — lib/gbp/route-support.ts).
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; reviewDocId: string }> };

const aiGateOff = () => gbpRefusal(403, "ai_gate_off", "Reviews AI is not enabled for this sub-account.");
const notConfigured = () => gbpRefusal(503, "ai_not_configured", "AI drafting isn't configured on this deployment.");

export async function POST(request: Request, ctx: Ctx) {
  const { id, reviewDocId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data();
  if (sub?.reviewsAiEnabledByAgency !== true) return aiGateOff();

  const target = await loadReplyTarget(id, reviewDocId);
  if (!target) return gbpRefusal(404, "not_found", "Review not found.");
  if (!reviewsAiConfigured()) return notConfigured();

  const rate = checkDraftRate(id, access.uid);
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many drafts — wait a minute.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  let ai;
  try {
    ai = await getReviewsAiFor(id);
  } catch (err) {
    if (err instanceof ReviewsAiFakeRefusedError) return notConfigured();
    throw err;
  }
  const input = await draftInputFor(id, target.docId);
  const stop = await beginDraftCall(id);
  if (stop === "daily_cap") return gbpRefusal(429, "daily_cap", "Daily AI limit reached — try again tomorrow.");
  if (stop === "ai_gate_off") return aiGateOff();
  if (stop === "gate_off") return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");

  const result = await ai.draftReply(input);
  if (result.text === null) {
    console.warn(`[gbp/draft] no draft sa=${id} failure=${result.failure}`);
    return gbpRefusal(424, "draft_failed", "The AI couldn't draft a reply this time. Try again, or write your own.");
  }
  return NextResponse.json({ draft: result.text });
}

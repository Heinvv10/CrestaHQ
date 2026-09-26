import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { loadReplyTarget } from "@/lib/gbp/reply";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { dismissAutoReply } from "@/lib/reputation/auto-reply/store";

/**
 * POST /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/auto-reply/dismiss —
 * the Reviews tab's Discard: the review's auto-reply draft is marked
 * dismissed for its current content (and recorded outside the cache), so the
 * engine never drafts or posts that review again unless the review changes
 * (AUTO_REPLY_V1_PLAN.md, state table). Nothing reaches Google.
 *
 * Addressed and guarded exactly like the reply route: sub-account admin only,
 * agency-gated (403 `gate_off`), and the review must be an active cached
 * review of this sub-account's current listing (else 404 — a guessed id from
 * another tenant names nothing here). A review with a reply, or without an
 * auto-reply draft, is 409 `nothing_to_dismiss` (nothing written); a repeat
 * Discard is accepted.
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; reviewDocId: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id, reviewDocId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }
  const target = await loadReplyTarget(id, reviewDocId);
  if (!target) return gbpRefusal(404, "not_found", "Review not found.");
  const outcome = await dismissAutoReply(id, target.docId, access.uid, new Date());
  if (outcome === "not_found") return gbpRefusal(404, "not_found", "Review not found.");
  if (outcome === "nothing_to_dismiss") {
    return gbpRefusal(409, "nothing_to_dismiss", "This review has a reply or no auto-reply draft to discard.");
  }
  return NextResponse.json({ ok: true });
}

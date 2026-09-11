import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import {
  deleteReplyFor,
  loadReplyTarget,
  parseReplyBody,
  postReply,
  replyPreflight,
  type ReplyTarget,
} from "@/lib/gbp/reply";
import { gbpRefusal } from "@/lib/gbp/route-support";

/**
 * POST   /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/reply — post (or
 *        edit) the owner reply to one Google review: `{comment, idempotencyKey}`.
 * DELETE same path — delete it.
 *
 * An explicit, authenticated human action and nothing else: sub-account admin
 * only, agency-gated (403 `gate_off`), and the review must be an active cached
 * review of this sub-account's current listing (else 404 — a guessed id from
 * another tenant names nothing here). See lib/gbp/reply.ts for the
 * idempotency and failure contract.
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; reviewDocId: string }> };

async function authorize(
  request: Request,
  ctx: Ctx,
): Promise<{ id: string; uid: string; target: ReplyTarget } | NextResponse> {
  const { id, reviewDocId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }
  const target = await loadReplyTarget(id, reviewDocId);
  if (!target) return gbpRefusal(404, "not_found", "Review not found.");
  return { id, uid: access.uid, target };
}

export async function POST(request: Request, ctx: Ctx) {
  const auth = await authorize(request, ctx);
  if (auth instanceof NextResponse) return auth;
  const body = parseReplyBody(await request.json().catch(() => null));
  if (!body) {
    return gbpRefusal(400, "invalid_body", "A reply needs text (at most 4000 characters) and an idempotency key.");
  }
  const blocked = await replyPreflight(auth.id);
  if (blocked) return blocked;
  return postReply(auth.id, auth.target, body, auth.uid);
}

export async function DELETE(request: Request, ctx: Ctx) {
  const auth = await authorize(request, ctx);
  if (auth instanceof NextResponse) return auth;
  const blocked = await replyPreflight(auth.id);
  if (blocked) return blocked;
  return deleteReplyFor(auth.id, auth.target, auth.uid);
}

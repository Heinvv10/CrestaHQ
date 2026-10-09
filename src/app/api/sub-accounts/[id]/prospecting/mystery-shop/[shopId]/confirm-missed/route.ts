import "server-only";

import { NextResponse } from "next/server";
import { isDocId } from "@/lib/server/doc-id";
import { prospectingAccess } from "@/lib/prospecting/reports";
import { confirmMissed } from "@/lib/prospecting/mystery-shop/store";

/**
 * POST — a member confirms a missed mystery shop after checking the inbox,
 * the Junk folder and the call log. Only a confirmed miss appears on the
 * public report (lib/prospecting/mystery-shop/section.ts). Idempotent: a
 * repeat keeps the first confirmation. 404 for a shop that is missing or
 * another sub-account's (the same body); 409 `not_missed` for any other
 * status; 409 `send_uncertain` for a miss whose enquiry may never have been sent.
 * A WhatsApp miss: 409 `opted_out` (the business replied STOP), `not_delivered`
 * (no delivery receipt) and `review_auto_reply` unless the body says
 * `{ reviewedAutoReply: true }` after an automatic-looking reply.
 */
/** A WhatsApp miss's own refusals (store.ts `confirmMissed`). */
const REFUSALS = {
  opted_out: "The business replied STOP.",
  not_delivered: "WhatsApp never confirmed this message was delivered, so it can't be published as a missed lead.",
  review_auto_reply: "A reply arrived that looked automatic — read the WhatsApp thread before confirming.",
} as const;

export async function POST(request: Request, ctx: { params: Promise<{ id: string; shopId: string }> }) {
  const { id: subAccountId, shopId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const body = (await request.json().catch(() => null)) as { reviewedAutoReply?: unknown } | null;
  const reviewedAutoReply = body?.reviewedAutoReply === true;
  const result = isDocId(shopId) ? await confirmMissed(shopId, subAccountId, access.uid, { reviewedAutoReply }) : "not_found";
  if (result === "not_found") return NextResponse.json({ error: "Mystery shop not found" }, { status: 404 });
  if (result === "not_missed") {
    return NextResponse.json({ error: "Only a missed shop can be confirmed.", code: "not_missed" }, { status: 409 });
  }
  if (result === "send_uncertain") {
    return NextResponse.json(
      { error: "This enquiry may not have been sent, so it can't be published as a missed lead.", code: "send_uncertain" },
      { status: 409 },
    );
  }
  const refusal = REFUSALS[result as keyof typeof REFUSALS];
  if (refusal) return NextResponse.json({ error: refusal, code: result }, { status: 409 });
  return NextResponse.json({ ok: true, missedConfirmedAt: (result as Date).toISOString() });
}

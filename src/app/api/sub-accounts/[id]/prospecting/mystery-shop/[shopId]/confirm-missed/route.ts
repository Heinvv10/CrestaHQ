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
 * another sub-account's (the same body); 409 `not_missed` for any other status.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; shopId: string }> }) {
  const { id: subAccountId, shopId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const result = isDocId(shopId) ? await confirmMissed(shopId, subAccountId, access.uid) : "not_found";
  if (result === "not_found") return NextResponse.json({ error: "Mystery shop not found" }, { status: 404 });
  if (result === "not_missed") {
    return NextResponse.json({ error: "Only a missed shop can be confirmed.", code: "not_missed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, missedConfirmedAt: result.toISOString() });
}

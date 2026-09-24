import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";

const STATUSES = new Set([
  "pending",
  "executing",
  "executed",
  "failed",
  "rejected",
  "expired",
  "unsettled",
]);

/**
 * List a sub-account's agent proposals, newest first (optionally one
 * `?status=`). Same audience as the firestore.rules read: any member.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !STATUSES.has(status)) {
    return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  }
  let q = getAdminDb()
    .collection("agentProposals")
    .where("subAccountId", "==", subAccountId);
  if (status) q = q.where("status", "==", status);
  const snap = await q.orderBy("createdAt", "desc").limit(100).get();
  return NextResponse.json({
    proposals: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
  });
}

import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import {
  aiOutboundSmsGateOn,
  aiOutboundSmsReadiness,
} from "@/lib/comms/ai/outbound-sms";
import type { SubAccountDoc } from "@/types";

/**
 * Prerequisite checklist behind the "AI texts" gate, for the Manage dialog.
 * Agency owner only, same as the gate itself. The feature-gates PATCH runs
 * the same checks, so this is display only.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = snap.data() as SubAccountDoc;
  const { ready, checks } = await aiOutboundSmsReadiness(subAccountId, sub);
  return NextResponse.json({
    gateOn: aiOutboundSmsGateOn(sub),
    ready,
    checks,
  });
}

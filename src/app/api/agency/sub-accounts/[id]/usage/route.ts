import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-tenancy";
import {
  computeOverage,
  getEffectiveQuotas,
  getEffectiveRates,
  usageMonthKey,
  usageRebillingState,
} from "@/lib/server/usage-meter";
import { usageCurrency } from "@/lib/billing/currency";
import type { UsageMonthDoc } from "@/types/usage";
import type { SubAccountDoc } from "@/types";

/**
 * Usage Metering v1 — owner-only read of a workspace's usage ledger.
 * Returns the current month plus the two before it, and the workspace's
 * effective quotas (override → plan → null=unlimited). The ledger is
 * server-only in Firestore rules, so this route is the ONLY read surface;
 * usage is deliberately agency-eyes-only in v1 (see
 * USAGE_METERING_V1_PLAN.md). The overage preview is only valued while
 * the client is rebilled (agency switch AND client switch); otherwise
 * rates are inert and it reports zero.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;

  const access = await requireAgencyOwner(request, sub.agencyId);
  if (access instanceof NextResponse) return access;

  const now = new Date();
  const months: string[] = [0, 1, 2].map((back) =>
    usageMonthKey(new Date(now.getFullYear(), now.getMonth() - back, 1)),
  );
  const snaps = await db.getAll(
    ...months.map((m) => db.doc(`subAccounts/${subAccountId}/usage/${m}`)),
  );
  const usage = months.map((month, i) => {
    const d = (snaps[i].data() as UsageMonthDoc | undefined) ?? {};
    return {
      month,
      emailsSent: d.emailsSent ?? 0,
      smsSegments: d.smsSegments ?? 0,
      whatsappMessages: d.whatsappMessages ?? 0,
      aiTokens: d.aiTokens ?? 0,
      voiceSeconds: d.voiceSeconds ?? 0,
    };
  });

  const quotas = await getEffectiveQuotas(subAccountId, sub);
  const rates = await getEffectiveRates(subAccountId, sub);
  const rebilling = await usageRebillingState(sub);

  // Value the current month's usage BEYOND the included quotas at the
  // configured sell rates — only for a rebilled client. Display only; no
  // charge is created from it yet.
  const currentDoc = (snaps[0].data() as UsageMonthDoc | undefined) ?? {};
  const overage = rebilling.active
    ? computeOverage(currentDoc, quotas, rates)
    : { perUnit: {}, totalCents: 0 };

  return NextResponse.json({
    usage,
    quotas,
    rates,
    overage,
    currency: usageCurrency(sub.billing),
    quotaSource: sub.usageQuotas
      ? "workspace"
      : sub.billing?.planId && quotas
        ? "plan"
        : "none",
    rebilling,
  });
}

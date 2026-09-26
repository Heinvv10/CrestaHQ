import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { REPORT_ID, prospectingAccess, serializeReport } from "@/lib/prospecting/reports";

/**
 * GET — one prospect report, for members of the sub-account that owns it.
 * Sections keep their `raw` (the member view renders it). A report of another
 * sub-account is the same 404 as a missing one.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; reportId: string }> },
) {
  const { id: subAccountId, reportId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = REPORT_ID.test(reportId)
    ? await getAdminDb().doc(`prospectReports/${reportId}`).get()
    : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }
  return NextResponse.json({ report: serializeReport(reportId, data) });
}

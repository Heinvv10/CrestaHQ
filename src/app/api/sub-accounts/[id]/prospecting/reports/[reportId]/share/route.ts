import "server-only";

import { NextResponse } from "next/server";
import { REPORT_ID, prospectingAccess } from "@/lib/prospecting/reports";
import { mintReportShare, revokeReportShare } from "@/lib/prospecting/share";

/**
 * Public share link for a ready report.
 *
 *   POST   → mint a link (revoking any live one) and return `{ url }` — the
 *            only time the token is ever shown. 409 unless the report is ready.
 *   DELETE → revoke the live link; the public page 404s from then on.
 *
 * Member + gate + the report must belong to this sub-account (else 404).
 */

const NOT_FOUND = () => NextResponse.json({ error: "Report not found" }, { status: 404 });

type Ctx = { params: Promise<{ id: string; reportId: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id: subAccountId, reportId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!REPORT_ID.test(reportId)) return NOT_FOUND();

  const minted = await mintReportShare({ reportId, subAccountId, uid: access.uid });
  if (minted === "not_found") return NOT_FOUND();
  if (minted === "not_ready") {
    return NextResponse.json({ error: "Only a finished report can be shared." }, { status: 409 });
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return NextResponse.json({ url: `${appUrl}/report/${minted.token}` });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id: subAccountId, reportId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!REPORT_ID.test(reportId)) return NOT_FOUND();

  if (!(await revokeReportShare({ reportId, subAccountId }))) return NOT_FOUND();
  return NextResponse.json({ ok: true });
}

import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { REPORT_ID, prospectingAccess, serializeReport } from "@/lib/prospecting/reports";
import { mysteryShopSections, serializeShop } from "@/lib/prospecting/mystery-shop/section";

/**
 * GET — one prospect report, for members of the sub-account that owns it.
 * Sections go through the public whitelist (`serializeReport`), so `raw`
 * never leaves the server. A report of another sub-account is the same 404
 * as a missing one. `mysteryShop` is report sections 11 and 12 from the
 * contact's shops, member view (target shown, open shops as waiting).
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
  // Equality-only: no composite index.
  const shops = await getAdminDb()
    .collection("mysteryShops")
    .where("subAccountId", "==", subAccountId)
    .where("contactId", "==", data.contactId)
    .get();
  const mysteryShop = mysteryShopSections(
    shops.docs.map((d) => serializeShop(d.id, d.data() ?? {})),
    { audience: "member", nowMs: Date.now(), timeZone: access.sub.timezone },
  );
  return NextResponse.json({ report: serializeReport(reportId, data), mysteryShop });
}

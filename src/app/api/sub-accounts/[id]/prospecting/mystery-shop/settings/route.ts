import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { prospectingEnabled, prospectingGateOff } from "@/lib/prospecting/gate";
import { parseJobValues } from "@/lib/prospecting/mystery-shop/job-value";
import { parseTemplates } from "@/lib/prospecting/mystery-shop/enquiry";
import type { SubAccountDoc } from "@/types";

/**
 * PUT — the sub-account's mystery-shop settings, from the Prospecting page:
 * `{ jobValues?, templates? }`. Each one sent replaces the whole stored map
 * (`prospectingJobValues`, `prospectingMysteryShopTemplates`); one left out is
 * kept. Sub-account admins only (agency owners count), 403 `gate_off` while
 * Prospecting is off, 400 for anything that does not validate — whole cents
 * 0–100,000,000, niche keys ≤ 60 chars, ≤ 50 niches, templates ≤ 2,000 chars.
 * Like the Get Leads types, this is a feature-scoped admin route: there is no
 * general sub-account settings PATCH to extend.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const ref = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const sub = ((await ref.get()).data() ?? {}) as SubAccountDoc;
  if (!prospectingEnabled(sub)) return prospectingGateOff();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const update: Record<string, unknown> = {};
  if (body?.jobValues !== undefined) {
    const values = parseJobValues(body.jobValues);
    if (!values) {
      return NextResponse.json(
        { error: "Job values must be up to 50 niches, each a whole number of cents from 0 to 100,000,000." },
        { status: 400 },
      );
    }
    update.prospectingJobValues = values;
  }
  if (body?.templates !== undefined) {
    const templates = parseTemplates(body.templates);
    if (!templates) {
      return NextResponse.json(
        { error: "Templates may set emailSubject, emailBody and call, each up to 2,000 characters." },
        { status: 400 },
      );
    }
    update.prospectingMysteryShopTemplates = templates;
  }
  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "Send jobValues or templates." }, { status: 400 });
  }
  await ref.update(update);
  return NextResponse.json({ ok: true, ...update });
}

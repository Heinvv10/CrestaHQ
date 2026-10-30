import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { prospectingEnabled, prospectingGateOff } from "@/lib/prospecting/gate";
import { parseJobValues } from "@/lib/prospecting/mystery-shop/job-value";
import { parseTemplates } from "@/lib/prospecting/mystery-shop/enquiry";
import { isDocId } from "@/lib/server/doc-id";
import type { MysteryShopTemplates, SubAccountDoc } from "@/types";

/**
 * PUT — the sub-account's mystery-shop settings, from the Prospecting page:
 * `{ jobValues?, templates?, whatsappTemplateId? }`. jobValues and templates
 * each replace their whole stored map (`prospectingJobValues`,
 * `prospectingMysteryShopTemplates`); one left out is kept. The WhatsApp
 * template choice lives in the templates map but is its own field: saving the
 * wording keeps it, and `whatsappTemplateId` (a template of THIS sub-account,
 * or null for the default by name) keeps the wording. Sub-account admins only
 * (agency owners count), 403 `gate_off` while Prospecting is off, 400 for
 * anything that does not validate — whole cents 0–100,000,000, niche keys ≤ 60
 * chars, ≤ 50 niches, templates ≤ 2,000 chars.
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
  let templates: MysteryShopTemplates | undefined;
  if (body?.templates !== undefined) {
    const parsed = parseTemplates(body.templates);
    if (!parsed) {
      return NextResponse.json(
        { error: "Templates may set emailSubject, emailBody, call and form, each up to 2,000 characters." },
        { status: 400 },
      );
    }
    templates = parsed;
  }
  const { whatsappTemplateId: storedChoice, ...storedWording } = sub.prospectingMysteryShopTemplates ?? {};
  let chosen = storedChoice;
  if (body?.whatsappTemplateId !== undefined) {
    const id = body.whatsappTemplateId;
    const exists =
      id === null || (isDocId(id) && (await getAdminDb().doc(`subAccounts/${subAccountId}/whatsappTemplates/${id}`).get()).exists);
    if (!exists) return NextResponse.json({ error: "Pick one of this sub-account's WhatsApp templates." }, { status: 400 });
    chosen = id ?? undefined;
  }
  if (templates || body?.whatsappTemplateId !== undefined) {
    update.prospectingMysteryShopTemplates = { ...(templates ?? storedWording), ...(chosen ? { whatsappTemplateId: chosen } : {}) };
  }
  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "Send jobValues, templates or whatsappTemplateId." }, { status: 400 });
  }
  await ref.update(update);
  return NextResponse.json({ ok: true, ...update });
}

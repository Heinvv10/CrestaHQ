import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { submitWhatsappTemplate } from "@/lib/comms/whatsapp/template-submit";

export const dynamic = "force-dynamic";

/**
 * Submit a draft (or rejected/failed) WhatsApp template to Meta for approval,
 * over whichever rail this sub-account sends on. The submission itself lives
 * in template-submit.ts, shared with the agent's submit_whatsapp_template.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id: subAccountId, templateId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const submitted = await submitWhatsappTemplate(subAccountId, templateId);
  if (!submitted.ok) {
    return NextResponse.json({ error: submitted.error }, { status: submitted.status });
  }

  const updated = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/whatsappTemplates/${templateId}`)
    .get();
  return NextResponse.json({ ok: true, template: { id: templateId, ...updated.data() } });
}

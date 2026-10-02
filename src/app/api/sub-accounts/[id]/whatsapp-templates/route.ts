import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createWhatsappTemplateDraft,
  type TemplateDraftInput,
} from "@/lib/comms/whatsapp/template-create";

export const dynamic = "force-dynamic";

/**
 * WhatsApp templates CRUD (list + create draft). Drafts are created here;
 * submission for Meta approval is a separate route ([templateId]/submit).
 * Admin-only. Validation and the stored shape live in template-create.ts,
 * shared with the agent's create_whatsapp_template.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/whatsappTemplates`)
    .orderBy("createdAt", "desc")
    .get();
  const templates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ templates });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  let body: TemplateDraftInput;
  try {
    body = (await request.json()) as TemplateDraftInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const created = await createWhatsappTemplateDraft({
    subAccountId,
    input: body,
    createdByUid: auth.uid,
  });
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: created.status });
  }

  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/whatsappTemplates/${created.id}`)
    .get();
  return NextResponse.json({ ok: true, template: { id: created.id, ...snap.data() } });
}

import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { parseWidgetConfig } from "@/lib/gbp/feed/origins";
import { PUBLIC_ID_RE, publicWidget, readWidgetMeta, revokeWidget, saveWidget } from "@/lib/gbp/feed/widget-store";
import { gbpRefusal } from "@/lib/gbp/route-support";

/**
 * The public reviews widget of a sub-account (one at most).
 *
 *   GET    → {widget | null}                    admin, gated
 *   PUT    {enabled, allowedOrigins, maxReviews, layout?, theme?, expectedPublicId?} admin, gated — creates or updates
 *   DELETE → {ok:true}                           admin, UNGATED — revoke (old id → 404)
 *
 * Rotate is POST …/widget/rotate. DELETE stays ungated like disconnect, so a
 * widget can always be taken down after the agency switched the feature off.
 *
 * `expectedPublicId` is the widget the caller's form was opened on (null:
 * none). When sent and it is not the stored one — a "create" form opened
 * before another save made the widget, or a form left open across a rotate
 * or revoke — nothing is written: 409 widget_changed. The dashboard always
 * sends it; a caller that omits it (curl, scripts) saves unconditionally.
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const gateOff = () => gbpRefusal(403, "gate_off", "This feature is locked by your agency.");

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) return gateOff();
  return NextResponse.json({ widget: publicWidget(await readWidgetMeta(id)) });
}

export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) return gateOff();

  const body: unknown = await request.json().catch(() => undefined);
  let expected: string | null | undefined;
  let config = body;
  if (typeof body === "object" && body !== null && !Array.isArray(body) && "expectedPublicId" in body) {
    const { expectedPublicId, ...rest } = body as Record<string, unknown>;
    if (expectedPublicId !== null && (typeof expectedPublicId !== "string" || !PUBLIC_ID_RE.test(expectedPublicId))) {
      return gbpRefusal(400, "invalid_body", "expectedPublicId must be a widget id or null.");
    }
    expected = expectedPublicId;
    config = rest;
  }
  const parsed = parseWidgetConfig(config);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: parsed.code, details: parsed.details }, { status: 400 });
  }
  const meta = await saveWidget(id, access.uid, parsed.config, expected);
  if (meta === "changed") {
    return gbpRefusal(409, "widget_changed", "The widget changed since this page loaded. Reload to see it, then save again.");
  }
  return NextResponse.json({ widget: publicWidget(meta) });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  await revokeWidget(id);
  return NextResponse.json({ ok: true });
}

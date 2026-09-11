import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { parseWidgetConfig } from "@/lib/gbp/feed/origins";
import { publicWidget, readWidgetMeta, revokeWidget, saveWidget } from "@/lib/gbp/feed/widget-store";
import { gbpRefusal } from "@/lib/gbp/route-support";

/**
 * The public reviews widget of a sub-account (one at most).
 *
 *   GET    → {widget | null}                    admin, gated
 *   PUT    {enabled, allowedOrigins, maxReviews} admin, gated — creates or updates
 *   DELETE → {ok:true}                           admin, UNGATED — revoke (old id → 404)
 *
 * Rotate is POST …/widget/rotate. DELETE stays ungated like disconnect, so a
 * widget can always be taken down after the agency switched the feature off.
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
  const parsed = parseWidgetConfig(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: parsed.code, details: parsed.details }, { status: 400 });
  }
  const meta = await saveWidget(id, access.uid, parsed.config);
  return NextResponse.json({ widget: publicWidget(meta) });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  await revokeWidget(id);
  return NextResponse.json({ ok: true });
}

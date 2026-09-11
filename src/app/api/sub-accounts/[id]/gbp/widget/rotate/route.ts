import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { publicWidget, rotateWidget } from "@/lib/gbp/feed/widget-store";
import { gbpRefusal } from "@/lib/gbp/route-support";

/**
 * POST /api/sub-accounts/[id]/gbp/widget/rotate — a new publicId with the
 * same config; the old id 404s from the next request on (the site must be
 * given the new snippet). Admin, gated. 404 `no_widget` when there is none.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }
  const meta = await rotateWidget(id);
  if (!meta) return gbpRefusal(404, "no_widget", "There is no widget to rotate.");
  return NextResponse.json({ widget: publicWidget(meta) });
}

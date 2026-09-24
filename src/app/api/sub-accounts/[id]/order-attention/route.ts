import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { listOrderFlags, resolveOrderFlag } from "@/lib/server/billing-attention";

/**
 * Orders whose payment arrived but settled nothing (`order.attention`).
 * Sub-account admins and the agency owner only — collaborators get 403.
 *   GET  → `{ items }` — unresolved flags, newest first
 *   POST `{ orderId }` → mark its flag resolved (records who and when)
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  return NextResponse.json({ items: await listOrderFlags(id) });
}

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  const body = (await request.json().catch(() => null)) as { orderId?: unknown } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  if (!orderId || orderId.includes("/")) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }
  if (!(await resolveOrderFlag(id, orderId, access))) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

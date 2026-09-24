import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { listOrderFlags, resolveOrderFlag } from "@/lib/server/billing-attention";

/**
 * Orders whose payment arrived but settled nothing (`order.attention`).
 * Sub-account admins and the agency owner only — collaborators get 403.
 *   GET  → `{ items }` — unresolved flags, newest first
 *   POST `{ orderId, flagId }` → mark one resolved (records who and when);
 *        409 when the order's note changed since it was listed.
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
  const body = (await request.json().catch(() => null)) as { orderId?: unknown; flagId?: unknown } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  const flagId = typeof body?.flagId === "string" ? body.flagId : "";
  if (!orderId || orderId.includes("/") || !flagId) {
    return NextResponse.json({ error: "orderId and flagId are required" }, { status: 400 });
  }
  const outcome = await resolveOrderFlag(id, orderId, flagId, access);
  if (outcome === "not_found") return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  if (outcome === "stale") {
    return NextResponse.json({ error: "This order's note changed — reload and check it again." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

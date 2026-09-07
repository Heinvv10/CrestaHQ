import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { restartTenant } from "@/lib/comms/whatsapp/manager-client";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";

/**
 * Bounce this workspace's bridge to get a fresh batch of pairing codes.
 *
 * The bridge has no re-pair endpoint of its own: a logged-out session only
 * issues a code on a fresh start, so a restart IS the re-pair control. It is
 * also briefly a delivery hole — the number is deaf while the unit comes
 * back — which is why it is admin-only rather than something the pairing
 * screen may fire on its own.
 *
 * TENANCY — `params.id`, validated by requireSubAccountAdmin, and nothing from
 * the request. The manager restarts whatever tenant the path names.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const result = await restartTenant(subAccountId);
  if (!result.ok) return managerFailureResponse(result);

  return NextResponse.json({ ok: true });
}

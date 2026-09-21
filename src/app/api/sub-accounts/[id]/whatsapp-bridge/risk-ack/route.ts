import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { recordRiskAck } from "@/lib/comms/whatsapp/bridge-risk-ack";
import { WA_BRIDGE_RISK_TEXT_ID } from "@/types/whatsapp-bridge";

/**
 * Record that a named admin agreed to the bridge rail's ban-risk warning.
 *
 * TENANCY — the record is written under `params.id`, which
 * `requireSubAccountAdmin` has just checked the caller's membership against.
 * The route reads NOTHING from the body: an acknowledgement that named its own
 * sub-account would let one workspace's admin unlock provisioning for another.
 *
 * The uid comes from the session for the same reason. An audit record whose
 * subject the client chose records nothing.
 *
 * Nothing is echoed back but the version id. The text the admin agreed to is
 * the one this deployment shipped, not one they posted.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  await recordRiskAck(subAccountId, auth.uid);

  return NextResponse.json({ ok: true, textId: WA_BRIDGE_RISK_TEXT_ID });
}

import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  BillingError,
  cancelOneTimeCharge,
  mintChargeCheckoutLink,
} from "@/lib/server/billing-service";

/**
 * One charge's management endpoints (agency owner only):
 *
 *   PATCH { action: "sendLink" } — rotate the token, return a fresh
 *         /pay/charge URL (older links go dead).
 *   DELETE — cancel a pending charge (voids the link; paid charges refuse —
 *         refunds happen in the Stripe dashboard).
 */

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; chargeId: string }> },
) {
  const { id: subAccountId, chargeId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  let body: { action?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.action !== "sendLink") {
    return NextResponse.json(
      { error: 'action must be "sendLink".' },
      { status: 400 },
    );
  }

  try {
    const url = await mintChargeCheckoutLink({
      agencyId: access.agencyId!,
      chargeId,
    });
    if (!url) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_APP_URL isn't configured — can't build the link." },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, checkoutUrl: url });
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[billing/charges] sendLink failed", err);
    return NextResponse.json(
      { error: "Failed to mint a link." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; chargeId: string }> },
) {
  const { id: subAccountId, chargeId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  try {
    await cancelOneTimeCharge({ agencyId: access.agencyId!, chargeId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[billing/charges] cancel failed", err);
    return NextResponse.json(
      { error: "Failed to cancel the charge." },
      { status: 500 },
    );
  }
}

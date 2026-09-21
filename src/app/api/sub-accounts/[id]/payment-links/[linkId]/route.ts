import { NextResponse } from "next/server";

import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { deactivatePaymentLink } from "@/lib/server/payment-links-service";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/sub-accounts/[id]/payment-links/[linkId] — body `{ active: false }`.
 *
 * Deactivation only; there is no reactivate in PR1. A deactivated link opens
 * no new checkout, but a payment already under way still records when its
 * webhook arrives — the money is real either way.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id: subAccountId, linkId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { active?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.active !== false) {
    return NextResponse.json({ error: "Only { active: false } is supported." }, { status: 400 });
  }

  const result = await deactivatePaymentLink({ subAccountId, linkId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}

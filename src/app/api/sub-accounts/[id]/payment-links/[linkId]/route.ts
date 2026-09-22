import { NextResponse } from "next/server";

import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { getAdminDb } from "@/lib/firebase/admin";
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

  // Same territory rule as create: a scoped collaborator may only act on
  // links for contacts they can see. Ad-hoc links carry no contact.
  const link = (await getAdminDb().doc(`paymentLinks/${linkId}`).get()).data();
  if (link?.subAccountId === subAccountId && link.contactId) {
    const gate = await territoryGateForContact(access, link.contactId as string);
    if (gate) return gate;
  }

  const result = await deactivatePaymentLink({ subAccountId, linkId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";

import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { getAdminDb } from "@/lib/firebase/admin";
import { revokePaymentMandate } from "@/lib/server/payment-mandates";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/payment-mandates/[mandateId]/revoke
 *
 * Revokes a saved card for good: the authorization is deleted, so nothing
 * can charge it again. No body. Any member may revoke, as any member may
 * issue the link that created it — stopping charges is the safe direction.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; mandateId: string }> },
) {
  const { id: subAccountId, mandateId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  // Same territory rule as payment links: a scoped collaborator acts only on
  // contacts they can see.
  if (/^[A-Za-z0-9-]{1,100}$/.test(mandateId)) {
    const mandate = (await getAdminDb().doc(`paymentMandates/${mandateId}`).get()).data();
    if (mandate?.subAccountId === subAccountId && mandate.contactId) {
      const gate = await territoryGateForContact(access, mandate.contactId as string);
      if (gate) return gate;
    }
  }

  const result = await revokePaymentMandate({ subAccountId, mandateId, uid: access.uid });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}

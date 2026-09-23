import { NextResponse } from "next/server";

import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { getAdminDb } from "@/lib/firebase/admin";
import { createPaymentLink } from "@/lib/server/payment-links-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/payment-links — create a Paystack payment link.
 *
 * Body: `{ invoiceId }` for an invoice, or `{ amountCents, description }` for
 * an ad-hoc amount. `{ invoiceId, mandate: true }` makes a card-on-file link
 * for a recurring invoice: paying it also saves the card. Any member may create one, as any member may send an
 * invoice. The amount stored here is the only amount the pay page will ever
 * charge. Listing happens client-side (member-read Firestore rule).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { invoiceId?: unknown; amountCents?: unknown; description?: unknown; mandate?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const invoiceId = typeof body.invoiceId === "string" && body.invoiceId ? body.invoiceId : undefined;

  if (invoiceId) {
    // A territory-scoped collaborator may only bill contacts they can see.
    const quote = (await getAdminDb().doc(`quotes/${invoiceId}`).get()).data();
    if (quote?.subAccountId === subAccountId) {
      const gate = await territoryGateForContact(access, quote.contactId as string);
      if (gate) return gate;
    }
  }

  const result = await createPaymentLink({
    subAccountId,
    uid: access.uid,
    invoiceId,
    amountCents: body.amountCents,
    description: body.description,
    mandate: body.mandate === true,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ id: result.link.id, token: result.link.token });
}

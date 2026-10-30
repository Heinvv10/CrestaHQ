import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { recheckCardCharge } from "@/lib/server/auto-charge-recheck";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/quotes/[quoteId]/recheck-card-charge
 *
 * "Re-check card charge" on an invoice whose recurring card charge is still
 * pending or unconfirmed: asks Paystack and records what it answers. See
 * `lib/server/auto-charge-recheck.ts`. Same gates as mark-paid: a member of
 * the sub-account, and the invoice's contact within the caller's territory.
 *
 * 200 `{ outcome: "paid" | "declined" | "pending" | "needs_attention" }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const quoteSnap = await getAdminDb().collection("quotes").doc(quoteId).get();
  if (!quoteSnap.exists) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  const quote = quoteSnap.data() as Quote;
  if (quote.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Quote belongs to a different sub-account" },
      { status: 403 },
    );
  }
  const gate = await territoryGateForContact(access, quote.contactId);
  if (gate) return gate;

  const result = await recheckCardCharge(subAccountId, quoteId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ outcome: result.outcome });
}

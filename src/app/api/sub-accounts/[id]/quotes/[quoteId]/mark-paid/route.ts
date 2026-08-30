import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/quotes/[quoteId]/mark-paid
 *
 * v1 has no inline payment collection — once the recipient accepts the
 * quote and the operator collects payment off-system (bank transfer,
 * card swipe, manual invoice, etc.), they click "Mark as paid" to flip
 * the quote into its terminal "paid" state.
 *
 * Gates: caller must be a sub-account member. State transitions:
 *   - quote (kind="quote"):   accepted → paid
 *   - invoice (kind="invoice"): sent | viewed → paid
 * Returns 409 if the doc isn't ready to be marked paid (still draft,
 * declined, or already paid).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const quoteRef = db.collection("quotes").doc(quoteId);
  const quoteSnap = await quoteRef.get();
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

  // The status checks, the write, and every side-effect (activity row,
  // `quote.paid` trigger, outbound webhook, auto review request) live in the
  // shared service so the Stripe order reconciler drives the identical path.
  // See lib/server/quotes-service.ts.
  const result = await markQuotePaidServerSide({
    quoteId,
    expectSubAccountId: subAccountId,
  });

  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "wrong_tenant"
          ? 403
          : 409;
    return NextResponse.json({ error: result.message }, { status });
  }

  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { createQuote, type CreateQuotePayload } from "@/lib/server/quote-write";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/quotes
 *
 * Create a new quote for a contact. Caller must be an active member of
 * the sub-account (any role — admin or collaborator). The server:
 *   1. Verifies contact exists + belongs to this sub-account
 *   2. Issues a per-sub-account sequence number (atomic txn)
 *   3. Persists the new quote with defaults + supplied fields
 *
 * The token is NOT issued here — it's issued by the /send endpoint when
 * the operator actually sends the quote. Until then the public URL
 * doesn't exist.
 *
 * Body shape (all optional except contactId):
 *   {
 *     contactId: string,
 *     lineItems?: QuoteLineItem[],
 *     currency?: string,
 *     globalDiscount?: QuoteDiscount,
 *     globalTaxPercent?: number | null,
 *     termsAndNotes?: string,
 *     billedToOrganization?: string | null,
 *     validUntilDateString?: string | null,   // "yyyy-mm-dd"
 *     autoCreateDealOnAccept?: boolean,
 *     dealId?: string | null,               // link an existing pipeline deal
 *   }
 *
 * Returns: `{ id, quoteNumber }` on success.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateQuotePayload;
  try {
    body = (await request.json()) as CreateQuotePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
  if (!contactId) {
    return NextResponse.json(
      { error: "contactId is required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  if (!contactSnap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const contact = contactSnap.data() ?? {};
  if (contact.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Contact belongs to a different sub-account" },
      { status: 403 },
    );
  }
  // Territory scoping: a scoped collaborator can't create a quote for a
  // contact outside their assigned territories. No-op for admins /
  // owners / sub-accounts with scoping off.
  const gate = await territoryGate(
    access,
    (contact.territoryId as string | null | undefined) ?? null,
  );
  if (gate) return gate;

  const created = await createQuote({
    subAccountId,
    agencyId: access.agencyId ?? (contact.agencyId as string),
    createdByUid: access.uid,
    contactId,
    contact,
    body,
  });
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: created.status });
  }

  return NextResponse.json(
    { id: created.id, quoteNumber: created.quoteNumber },
    { status: 201 },
  );
}

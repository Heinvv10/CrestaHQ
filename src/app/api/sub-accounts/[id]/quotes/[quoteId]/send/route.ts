import { NextResponse } from "next/server";

import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryDenialForContact } from "@/lib/auth/territory-filter";
import { sendQuoteServerSide } from "@/lib/server/quote-send-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/quotes/[quoteId]/send
 *
 * Send (or re-send) a quote or invoice to its recipient.
 *
 * This route is a thin caller: it authenticates, then hands off to
 * `sendQuoteServerSide()`, which owns the send mechanics (token rotation,
 * payment-link mint, email, lifecycle write, side-effects) so the recurring-
 * invoice cron sends through the exact same path.
 *
 * Auth here is two-layered: sub-account membership, plus a territory check so
 * a scoped collaborator can only send quotes whose contact is in one of their
 * assigned territories. The territory check runs inside the service's
 * `authorize` hook, at the point it needs the loaded quote's `contactId`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const result = await sendQuoteServerSide({
    subAccountId,
    quoteId,
    replyTo: access.email,
    authorize: (quote) => territoryDenialForContact(access, quote.contactId),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.failure.error },
      { status: result.failure.status },
    );
  }

  return NextResponse.json({
    ok: true,
    sentTo: result.sentTo,
    paymentLinkUrl: result.paymentLinkUrl,
  });
}

import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeServer } from "@/lib/stripe/server";
import { billingStripeIsConfigured } from "@/lib/server/billing-service";

/**
 * Stripe Billing Portal for a billed sub-account (Client Billing v1) —
 * the "Manage billing" button in workspace settings. Lets the client
 * update their card, view invoices, and see the subscription — all on
 * Stripe's hosted portal, keyed to the sub-account's own Stripe customer.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!billingStripeIsConfigured()) {
    return NextResponse.json(
      { error: "Stripe isn't configured on this deployment." },
      { status: 503 },
    );
  }

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const customerId = snap.data()?.billing?.stripeCustomerId as
    | string
    | null
    | undefined;
  if (!customerId) {
    return NextResponse.json(
      { error: "No billing profile exists for this workspace yet." },
      { status: 409 },
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  try {
    const session = await getStripeServer().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${base}/sa/${subAccountId}/dashboard/settings`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[api/sub-accounts/billing/portal] failed", err);
    return NextResponse.json(
      { error: "Failed to open the billing portal." },
      { status: 500 },
    );
  }
}

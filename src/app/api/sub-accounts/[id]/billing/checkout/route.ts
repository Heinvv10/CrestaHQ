import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  BillingError,
  createSubAccountCheckoutSession,
} from "@/lib/server/billing-service";

/**
 * In-app activation checkout (Client Billing v1). The paywall/activation
 * screen inside the workspace posts here so a logged-in sub-account admin
 * can pay without needing the emailed token link. Returns the Stripe
 * Checkout URL to redirect to.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL isn't configured." },
      { status: 500 },
    );
  }
  const returnUrl = `${base}/sa/${subAccountId}/dashboard`;

  try {
    const { url } = await createSubAccountCheckoutSession({
      subAccountId,
      successUrl: returnUrl,
      cancelUrl: returnUrl,
    });
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[api/sub-accounts/billing/checkout] failed", err);
    return NextResponse.json(
      { error: "Failed to start checkout." },
      { status: 500 },
    );
  }
}

import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import {
  BillingError,
  createChargeCheckoutSession,
} from "@/lib/server/billing-service";

/**
 * In-app payment of one of this workspace's pending usage charges (the
 * overdue banner and paywall post here). The same checkout `/pay/charge/[token]`
 * opens, but for a signed-in sub-account admin, so no pay link is stored,
 * minted or rotated: the link in the invoice email keeps working.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; chargeId: string }> },
) {
  const { id: subAccountId, chargeId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!isDocId(chargeId)) {
    return NextResponse.json({ error: "Charge not found." }, { status: 404 });
  }

  const charge = (await getAdminDb().doc(`billingCharges/${chargeId}`).get()).data();
  if (charge?.subAccountId !== subAccountId || charge?.kind !== "usage") {
    return NextResponse.json({ error: "Charge not found." }, { status: 404 });
  }
  if (charge.status !== "pending") {
    return NextResponse.json(
      { error: charge.status === "paid" ? "This charge is already paid." : "This charge was waived." },
      { status: 409 },
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL isn't configured." },
      { status: 500 },
    );
  }
  const returnUrl = `${base}/sa/${subAccountId}/dashboard`;

  try {
    const { url } = await createChargeCheckoutSession({
      chargeId,
      successUrl: returnUrl,
      cancelUrl: returnUrl,
    });
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(
      "[usage-charges/checkout] failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Failed to start checkout." }, { status: 500 });
  }
}

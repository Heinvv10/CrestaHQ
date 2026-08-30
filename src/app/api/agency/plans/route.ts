import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import {
  sanitizeUsageQuotas,
  sanitizeUsageRates,
} from "@/lib/server/usage-meter";
import {
  BillingError,
  billingStripeIsConfigured,
  createPlanForAgency,
  listPlansForAgency,
  normalizePlanGates,
  validateAnnualPrice,
  validatePlanPricing,
} from "@/lib/server/billing-service";

/**
 * Agency billing plans (Client Billing v1). Owner-only. Plans live at
 * `agencies/{agencyId}/plans` (server-only writes; reads via this API so
 * no Firestore client rules are needed).
 */

function billingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof BillingError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  const plans = await listPlansForAgency(caller.agencyId!);
  return NextResponse.json({
    plans,
    stripeConfigured: billingStripeIsConfigured(),
  });
}

export async function POST(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) {
    return NextResponse.json(
      { error: "Plan name is required (1–60 characters)." },
      { status: 400 },
    );
  }
  const descriptionRaw =
    typeof body.description === "string" ? body.description.trim() : "";
  if (descriptionRaw.length > 300) {
    return NextResponse.json(
      { error: "Description must be 300 characters or fewer." },
      { status: 400 },
    );
  }

  try {
    const { priceMonthlyCents, currency } = validatePlanPricing(
      body.priceMonthlyCents,
      body.currency ?? "usd",
    );
    // Optional annual price. `undefined`/absent → null (monthly-only).
    const annual = validateAnnualPrice(body.priceAnnualCents);
    const plan = await createPlanForAgency({
      agencyId: caller.agencyId!,
      name,
      description: descriptionRaw || null,
      priceMonthlyCents,
      priceAnnualCents: annual ?? null,
      currency,
      gates: normalizePlanGates(body.gates),
      quotas: sanitizeUsageQuotas(body.quotas),
      rates: sanitizeUsageRates(body.rates),
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    const res = billingErrorResponse(err);
    if (res) return res;
    console.error("[api/agency/plans] create failed", err);
    return NextResponse.json(
      { error: "Failed to create the plan." },
      { status: 500 },
    );
  }
}

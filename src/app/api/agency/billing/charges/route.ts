import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { listChargesForAgency } from "@/lib/server/billing-service";

/** Owner-only: every one-time and usage charge across the agency's clients. */
export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  try {
    const charges = await listChargesForAgency(caller.agencyId!);
    return NextResponse.json({ charges });
  } catch (err) {
    console.error(
      "[agency/billing/charges] list failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Failed to load invoices." }, { status: 500 });
  }
}

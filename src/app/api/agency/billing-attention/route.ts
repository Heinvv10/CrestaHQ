import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import {
  listAgencyBillingFlags,
  resolveAgencyBillingFlag,
} from "@/lib/server/billing-attention";

/**
 * Flagged plan payments across the owner's sub-accounts (Client billing →
 * Attention). Owner-only; `billingEvents` stays server-only in rules.
 *   GET  → `{ items }` — unresolved flags, newest first
 *   POST `{ flagId }` → mark one resolved (records who and when)
 */

export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  return NextResponse.json({ items: await listAgencyBillingFlags(caller.agencyId!) });
}

export async function POST(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { flagId?: unknown } | null;
  const flagId = typeof body?.flagId === "string" ? body.flagId : "";
  if (!flagId || flagId.includes("/")) {
    return NextResponse.json({ error: "flagId is required" }, { status: 400 });
  }
  const ok = await resolveAgencyBillingFlag(caller.agencyId!, flagId, caller);
  if (!ok) return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

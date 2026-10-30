import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  normaliseSubdomain,
  subdomainAvailable,
  subdomainError,
  subdomainHostname,
} from "@/lib/funnels/subdomains";

export const dynamic = "force-dynamic";

/**
 * Live availability check for the builder's subdomain field. Admin +
 * Labs-gated — the claim registry's contents (who owns what name) shouldn't
 * be probeable anonymously, even though each individual answer is low-value.
 *
 * `funnelId` lets a funnel's own current subdomain read as available, so
 * re-saving without changes doesn't warn.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (subSnap.data()?.labsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Labs isn't enabled for this workspace." },
      { status: 403 },
    );
  }

  const sp = new URL(request.url).searchParams;
  const name = normaliseSubdomain(sp.get("name") ?? "");
  const funnelId = sp.get("funnelId") ?? undefined;

  const err = subdomainError(name);
  if (err) {
    return NextResponse.json({ ok: true, name, valid: false, reason: err });
  }

  const available = await subdomainAvailable(name, funnelId);
  return NextResponse.json({
    ok: true,
    name,
    valid: true,
    available,
    hostname: subdomainHostname(name),
    reason: available ? null : "Already used by another funnel.",
  });
}

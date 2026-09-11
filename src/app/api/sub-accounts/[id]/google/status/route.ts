import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { googleAppConfigured } from "@/lib/google/oauth";

/**
 * Whether Google Business Profile is usable on this deployment.
 *
 *   GET /api/sub-accounts/[id]/google/status → { configured }
 *
 * Any active member may ask; the Google Business page asks only for admins
 * (non-admins get a read-only notice and never reach Connect). A
 * deployment-level boolean only — no tenant data, no credential detail.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  return NextResponse.json({ configured: googleAppConfigured() });
}

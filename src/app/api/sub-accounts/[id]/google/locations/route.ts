import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { discoverLocations } from "@/lib/gbp/discovery";
import { withGbpAccess } from "@/lib/gbp/access";
import { gbpErrorResponse, gbpPreconditions } from "@/lib/gbp/route-support";

/**
 * The Business Profile listings this sub-account's Google connection can
 * manage — the data behind the listing picker.
 *
 *   GET /api/sub-accounts/[id]/google/locations
 *     → { accounts: [{ name, accountName, locations: [{ name, title, address,
 *         websiteUri, placeId, mapsUri }] }], truncated }
 *
 * Sub-account admin only, agency-gated. Walks every page of accounts and
 * locations (bounded at 20 pages each; `truncated` says when it stopped).
 * Refusals: 403 gate_off · 503 not_configured · 409 not_connected /
 * reconnect_required · 424 <provider error kind> (not 502: see route-support.ts).
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const pre = await gbpPreconditions(id);
  if (pre instanceof NextResponse) return pre;

  try {
    return NextResponse.json(await withGbpAccess(id, discoverLocations));
  } catch (err) {
    return gbpErrorResponse(err, id, "gbp/locations");
  }
}

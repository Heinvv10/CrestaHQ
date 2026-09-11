import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { discoverLocations } from "@/lib/gbp/discovery";
import { getGbpProviderFor } from "@/lib/gbp/provider/select";
import { gbpErrorResponse, gbpPreconditions } from "@/lib/gbp/route-support";
import { getValidAccessToken } from "@/lib/gbp/tokens";

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
 * reconnect_required · 502 <provider error kind>.
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
    const accessToken = await getValidAccessToken(id);
    const provider = await getGbpProviderFor(id);
    return NextResponse.json(await discoverLocations(provider, accessToken));
  } catch (err) {
    return gbpErrorResponse(err, id, "gbp/locations");
  }
}

import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { InsightsLocationRefusal, loadInsights } from "@/lib/gbp/insights";
import { LOCATION_NAME_RE } from "@/lib/gbp/provider/types";
import { gbpErrorResponse, gbpPreconditions, gbpRefusal } from "@/lib/gbp/route-support";
import { toMillis } from "@/lib/gbp/sync/types";
import { parseInsightsRange } from "@/lib/reputation/insights";

/**
 * GET /api/sub-accounts/[id]/reputation/insights?location=locations/…&range=7d|28d|90d
 * — Business Profile Performance insights (SP5 G2/G3), fetched on demand and
 * memoised in memory only (lib/gbp/insights.ts); nothing is stored.
 *
 * Any active member, for the selected listing. `location` defaults to the
 * listing; another value is ADMIN ONLY (the locations list behind the picker
 * is admin-only too) and must be a location THIS connection can see — the
 * server walks discovery (20-page bound) and never trusts the parameter.
 * Viewing another location never changes the listing.
 *
 * Refusals, `{error, code}`: 400 invalid_filter (range) · 400 unknown_location
 * / unverifiable_truncated · 403 location_admin_only · 403 gate_off · 503
 * not_configured · 409 not_connected / reconnect_required / no_listing · 424
 * <provider kind> (access_not_approved: Google's quota-0 refusal, worded).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const params = new URL(request.url).searchParams;
  const range = parseInsightsRange(params.get("range"));
  if (!range) {
    return NextResponse.json({ error: "Invalid filter: range", code: "invalid_filter", field: "range" }, { status: 400 });
  }

  const pre = await gbpPreconditions(id);
  if (pre instanceof NextResponse) return pre;
  const listing = pre.sub.googleListing;
  if (!listing?.locationName) return gbpRefusal(409, "no_listing", "No Business Profile listing is selected.");

  const locationName = params.get("location") || listing.locationName;
  if (!LOCATION_NAME_RE.test(locationName)) {
    return gbpRefusal(400, "unknown_location", "That listing isn't available to this Google connection.");
  }
  const admin = access.subAccountRole === "admin" || access.subAccountRole === "agencyOwner";
  if (locationName !== listing.locationName && !admin) {
    return gbpRefusal(403, "location_admin_only", "Only a sub-account admin can view another location.");
  }

  try {
    return NextResponse.json(
      await loadInsights({
        subAccountId: id,
        connectionKey: String(toMillis(pre.sub.googleConnectionMeta?.connectedAt)),
        listing: { locationName: listing.locationName, title: listing.title },
        locationName,
        range,
        now: new Date(),
      }),
    );
  } catch (err) {
    if (err instanceof InsightsLocationRefusal) {
      return err.code === "unknown_location"
        ? gbpRefusal(400, "unknown_location", "That listing isn't available to this Google connection.")
        : gbpRefusal(400, "unverifiable_truncated", "This Google account has too many listings to verify that one.");
    }
    return gbpErrorResponse(err, id, "reputation/insights");
  }
}

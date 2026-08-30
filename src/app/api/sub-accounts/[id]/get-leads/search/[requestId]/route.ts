import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  fetchResults,
  outscraperIsConfigured,
  OutscraperError,
} from "@/lib/get-leads/outscraper";
import {
  haversineKm,
  isValidLatitude,
  isValidLongitude,
} from "@/lib/get-leads/geo";
import type { SubAccountDoc } from "@/types";

/**
 * Get Leads — poll an in-flight search. The client passes back the search
 * origin + radius as query params so the picked radius can be enforced here
 * (Outscraper's coordinates param only anchors the Google Maps search;
 * Google decides its own spill-over area). Businesses Google returned
 * without coordinates are kept — they matched the area query and can't be
 * distance-checked.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; requestId: string }> },
) {
  const { id: subAccountId, requestId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;

  if (sub.getLeadsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Get Leads is locked by your agency." },
      { status: 403 },
    );
  }
  if (!outscraperIsConfigured()) {
    return NextResponse.json(
      { error: "OUTSCRAPER_API_KEY isn't configured on this deployment." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radiusKm = Number(url.searchParams.get("radiusKm"));
  const canFilter =
    isValidLatitude(lat) && isValidLongitude(lng) && radiusKm > 0;

  try {
    const poll = await fetchResults(requestId);
    if (poll.status === "pending") {
      return NextResponse.json({ ok: true, status: "pending" });
    }
    if (poll.status === "failed") {
      return NextResponse.json({ ok: true, status: "failed", error: poll.message });
    }

    const businesses = canFilter
      ? poll.businesses.filter(
          (b) =>
            b.latitude === null ||
            b.longitude === null ||
            haversineKm(
              { latitude: lat, longitude: lng },
              { latitude: b.latitude, longitude: b.longitude },
            ) <= radiusKm,
        )
      : poll.businesses;

    return NextResponse.json({
      ok: true,
      status: "success",
      businesses,
      totalBeforeRadiusFilter: poll.businesses.length,
    });
  } catch (err) {
    const status = err instanceof OutscraperError ? err.status : 502;
    console.error(
      `[get-leads/poll] failed sa=${subAccountId} req=${requestId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Couldn't fetch search results. Please try again." },
      { status: status >= 500 ? 502 : status },
    );
  }
}

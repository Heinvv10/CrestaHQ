import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { placesIsConfigured, searchPlaces, PlacesError } from "@/lib/get-leads/places";
import { geocodePlace, GeocodeError } from "@/lib/get-leads/geocode";
import { enrichBusinesses } from "@/lib/get-leads/enrich";
import {
  resolveBusinessType,
  RADIUS_OPTIONS_KM,
  RESULT_LIMIT_OPTIONS,
} from "@/lib/get-leads/business-types";
import { haversineKm, isValidLatitude, isValidLongitude } from "@/lib/get-leads/geo";
import type { SubAccountDoc } from "@/types";

/**
 * Get Leads — run a business search (EXPERIMENTAL), synchronously.
 *
 * POST runs a Google Places (New) Text Search biased to the picked
 * coordinates, drops results outside the picked radius (the bias is only a
 * preference — Google still returns spill-over), reads each remaining
 * business's homepage for an email + socials, and returns the finished list.
 * Results are never persisted — imports are the only durable output.
 *
 * Gated on `getLeadsEnabledByAgency` because every search spends the
 * agency's shared Places quota (a hard daily cap on the Google Cloud
 * project). The business type must come from the curated picklist so a
 * forged request can't run arbitrary queries on the agency's key.
 *
 * A request with a place name but no coordinates (free text typed on a
 * deployment without a Mapbox token) is geocoded here with the same Google
 * key — only after every other guard has passed, so a refused request never
 * spends a lookup.
 */

interface PostBody {
  businessType?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  /**
   * Per-search result cap. Must be one of RESULT_LIMIT_OPTIONS; every 20
   * results is one billable Places call.
   */
  maxResults?: number;
  /**
   * Human-readable place name. Required (and geocoded server-side) when
   * latitude/longitude are absent. Alongside coordinates it is only echoed
   * back for display — client text never reaches the Places query.
   */
  locationLabel?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
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
  if (!placesIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Lead search isn't available — GOOGLE_PLACES_API_KEY isn't configured on this deployment.",
      },
      { status: 503 },
    );
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Allowlist = curated picklist + this sub-account's admin-saved custom
  // types. Anything else is refused (protects the agency's Places key).
  const customTypes = Array.isArray(sub.getLeadsCustomTypes)
    ? sub.getLeadsCustomTypes.filter((t): t is string => typeof t === "string")
    : [];
  const type = resolveBusinessType(
    typeof body.businessType === "string" ? body.businessType : "",
    customTypes,
  );
  if (!type) {
    return NextResponse.json(
      { error: "Pick a business type from the list." },
      { status: 400 },
    );
  }
  // Coordinates (a picked suggestion or "Use my location") win; without
  // them the typed place name is geocoded below, after the remaining guards.
  const hasCoords = isValidLatitude(body.latitude) && isValidLongitude(body.longitude);
  const typedName =
    typeof body.locationLabel === "string"
      ? body.locationLabel.replace(/[\r\n\t]/g, " ").trim()
      : "";
  if (!hasCoords && (!typedName || typedName.length > 120)) {
    return NextResponse.json(
      { error: "A valid search location is required." },
      { status: 400 },
    );
  }
  const radiusKm = Number(body.radiusKm);
  if (!RADIUS_OPTIONS_KM.includes(radiusKm as (typeof RADIUS_OPTIONS_KM)[number])) {
    return NextResponse.json(
      { error: "Pick a radius from the list." },
      { status: 400 },
    );
  }
  const maxResults = Number(body.maxResults);
  if (
    !RESULT_LIMIT_OPTIONS.includes(
      maxResults as (typeof RESULT_LIMIT_OPTIONS)[number],
    )
  ) {
    return NextResponse.json(
      { error: "Pick a max results value from the list." },
      { status: 400 },
    );
  }

  let origin: { latitude: number; longitude: number };
  let locationLabel: string;
  // Only a name Google itself returned may ride in the text query.
  let queryPlace: string | null = null;
  if (hasCoords) {
    origin = { latitude: body.latitude as number, longitude: body.longitude as number };
    locationLabel = typedName.slice(0, 120);
  } else {
    try {
      const place = await geocodePlace(typedName);
      origin = { latitude: place.lat, longitude: place.lng };
      locationLabel = place.formattedName.slice(0, 120);
      queryPlace = locationLabel;
    } catch (err) {
      console.error(
        `[get-leads/search] geocode failed sa=${subAccountId}:`,
        err instanceof Error ? err.message : err,
      );
      if (err instanceof GeocodeError && err.reason === "not_found") {
        return NextResponse.json(
          { error: "We couldn't find that place — try a nearby town or suburb." },
          { status: 400 },
        );
      }
      if (err instanceof GeocodeError && err.reason === "quota") {
        return NextResponse.json(
          {
            error:
              "Daily location lookup limit reached — use “Use my location” or try again tomorrow.",
          },
          { status: 429 },
        );
      }
      return NextResponse.json(
        { error: "Couldn't look up that place. Please try again." },
        { status: 502 },
      );
    }
  }

  // With client coordinates the query is the allowlisted term alone — the
  // location bias anchors it, and a forged label must not become free text
  // on the agency's key. A server-geocoded name (Google's own formatted
  // address) rides along ("plumbers in Gqeberha, South Africa") for ranking.
  const textQuery = queryPlace ? `${type.query} in ${queryPlace}` : type.query;

  try {
    const found = await searchPlaces({
      textQuery,
      ...origin,
      radiusKm,
      limit: maxResults,
    });
    // Businesses without coordinates are kept — they matched the area
    // query and can't be distance-checked.
    const inRadius = found.filter(
      (b) =>
        b.latitude === null ||
        b.longitude === null ||
        haversineKm(origin, { latitude: b.latitude, longitude: b.longitude }) <= radiusKm,
    );
    const businesses = await enrichBusinesses(inRadius, request.signal);
    return NextResponse.json({
      ok: true,
      status: "success",
      businesses,
      totalBeforeRadiusFilter: found.length,
      origin: { ...origin, label: locationLabel },
    });
  } catch (err) {
    console.error(
      `[get-leads/search] failed sa=${subAccountId}:`,
      err instanceof Error ? err.message : err,
    );
    if (err instanceof PlacesError && err.quotaExhausted) {
      return NextResponse.json(
        { error: "Daily search limit reached — try again tomorrow." },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "The search failed. Please try again." },
      { status: 502 },
    );
  }
}

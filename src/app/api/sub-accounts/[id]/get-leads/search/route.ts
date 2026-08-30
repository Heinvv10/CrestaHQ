import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  outscraperIsConfigured,
  submitSearch,
  OutscraperError,
} from "@/lib/get-leads/outscraper";
import {
  resolveBusinessType,
  RADIUS_OPTIONS_KM,
  RESULT_LIMIT_OPTIONS,
} from "@/lib/get-leads/business-types";
import { isValidLatitude, isValidLongitude } from "@/lib/get-leads/geo";
import type { SubAccountDoc } from "@/types";

/**
 * Get Leads — submit a business search (EXPERIMENTAL).
 *
 * POST kicks off an async Outscraper Google Maps search (with the
 * leads_n_contacts email/social enrichment) anchored to the picked
 * coordinates, and returns the Outscraper request id. The client polls
 * GET /get-leads/search/[requestId] until results land (enrichment runs
 * 1–3 minutes). Results are never persisted — imports are the only
 * durable output.
 *
 * Gated on `getLeadsEnabledByAgency` because every search spends the
 * agency's shared Outscraper credits. The business type must come from
 * the curated picklist so a forged request can't run arbitrary queries
 * on the agency's key.
 */

interface PostBody {
  businessType?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  /**
   * Per-search result cap — the operator's credit budget for this run.
   * Must be one of RESULT_LIMIT_OPTIONS; passed to Outscraper as `limit`.
   */
  maxResults?: number;
  /** Optional human-readable place name, folded into the search query. */
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
  if (!outscraperIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Lead search isn't available — OUTSCRAPER_API_KEY isn't configured on this deployment.",
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
  // types. Anything else is refused (protects the agency's Outscraper key).
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
  if (!isValidLatitude(body.latitude) || !isValidLongitude(body.longitude)) {
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

  // The label rides inside the Google Maps query ("plumbers, Brisbane QLD"),
  // which helps ranking; coordinates anchor it regardless. Keep it tame.
  const locationLabel =
    typeof body.locationLabel === "string"
      ? body.locationLabel.replace(/[\r\n\t]/g, " ").trim().slice(0, 120)
      : "";
  const query = locationLabel ? `${type.query}, ${locationLabel}` : type.query;

  try {
    const requestId = await submitSearch({
      query,
      latitude: body.latitude,
      longitude: body.longitude,
      limit: maxResults,
      enrich: true,
    });
    return NextResponse.json({ ok: true, requestId });
  } catch (err) {
    const status = err instanceof OutscraperError ? err.status : 502;
    console.error(
      `[get-leads/search] submit failed sa=${subAccountId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      {
        error:
          status === 402
            ? "The agency's Outscraper account is out of credits."
            : "Couldn't start the search. Please try again.",
      },
      { status: status >= 500 ? 502 : status },
    );
  }
}

import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { findAccessibleLocations } from "@/lib/gbp/discovery";
import { listingFrom, saveExtraListings, storedExtras, type ListingPair } from "@/lib/gbp/extra-listings";
import { MAX_EXTRA_LISTINGS } from "@/lib/gbp/listings";
import { withGbpAccess } from "@/lib/gbp/access";
import { ACCOUNT_NAME_RE, LOCATION_NAME_RE } from "@/lib/gbp/provider/types";
import { gbpErrorResponse, gbpPreconditions, gbpRefusal } from "@/lib/gbp/route-support";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import type { GoogleListing } from "@/types/google";

/**
 * Set the EXTRA Business Profile listings this sub-account manages beside its
 * main one (MULTI_LISTING_V1_PLAN.md PR 3).
 *
 *   PUT /api/sub-accounts/[id]/google/extra-listings
 *       { listings: [{ accountName, locationName }, …] }   — the full new set, in order
 *
 * Sub-account admin only, agency-gated like the listing PUT. Trusts only the
 * resource names: every NEW pair is re-fetched through the provider in one
 * walk (400 unknown_location / unverifiable_truncated, as the listing PUT),
 * and only that re-fetch is stored; a pair already connected keeps its stored
 * listing. Refusals: 400 invalid_body, 400 too_many (above
 * MAX_EXTRA_LISTINGS), 400 is_main, 409 no_listing (no main listing), 409
 * listing_shared (another sub-account manages a new pair, as main or extra),
 * 409 listings_changed (a concurrent save; reload). Removing a listing drops
 * only that listing's synced data.
 */

const MAX_BODY_BYTES = 8 * 1024;

const TEXT: Record<string, [number, string]> = {
  no_listing: [409, "Choose the main listing first."],
  is_main: [400, "That is already the main listing."],
  listing_shared: [409, "Another workspace already manages that listing."],
  listings_changed: [409, "The additional listings changed meanwhile. Reload and try again."],
};

function parse(value: unknown): ListingPair[] | "too_many" | null {
  const listings = (value as { listings?: unknown } | null)?.listings;
  if (!Array.isArray(listings)) return null;
  if (listings.length > MAX_EXTRA_LISTINGS) return "too_many";
  const pairs: ListingPair[] = [];
  for (const item of listings) {
    const { accountName, locationName } = (item ?? {}) as Record<string, unknown>;
    if (typeof accountName !== "string" || !ACCOUNT_NAME_RE.test(accountName)) return null;
    if (typeof locationName !== "string" || !LOCATION_NAME_RE.test(locationName)) return null;
    if (pairs.some((p) => p.locationName === locationName)) return null;
    pairs.push({ accountName, locationName });
  }
  return pairs;
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const pre = await gbpPreconditions(id);
  if (pre instanceof NextResponse) return pre;

  const body = await readJsonCapped(request, MAX_BODY_BYTES);
  if (!body.ok && body.reason === "too_large") return gbpRefusal(413, "body_too_large", "Request body too large.");
  const pairs = body.ok ? parse(body.value) : null;
  if (pairs === "too_many") {
    return gbpRefusal(400, "too_many", `At most ${MAX_EXTRA_LISTINGS} additional listings.`);
  }
  if (!pairs) return gbpRefusal(400, "invalid_body", "listings must be a list of { accountName, locationName }.");

  // Only pairs not already connected are re-fetched: removing a listing
  // never needs Google.
  const known = new Set(storedExtras(pre.sub).map((l) => `${l.accountName}|${l.locationName}`));
  const fresh = pairs.filter((p) => !known.has(`${p.accountName}|${p.locationName}`));
  const fetched = new Map<string, GoogleListing>();
  if (fresh.length > 0) {
    let matches: Awaited<ReturnType<typeof findAccessibleLocations>>;
    try {
      matches = await withGbpAccess(id, (provider, token) => findAccessibleLocations(provider, token, fresh));
    } catch (err) {
      return gbpErrorResponse(err, id, "gbp/extra-listings");
    }
    if (matches.includes("unknown")) {
      return gbpRefusal(400, "unverifiable_truncated", "This Google account has too many listings to verify that one.");
    }
    for (const [i, match] of matches.entries()) {
      if (!match || match === "unknown") {
        return gbpRefusal(400, "unknown_location", "That listing isn't available to this Google connection.");
      }
      fetched.set(`${fresh[i].accountName}|${fresh[i].locationName}`, listingFrom(match.account, match.location, access.uid));
    }
  }

  const result = await saveExtraListings(id, access.uid, pairs, fetched);
  if (!result.ok) return gbpRefusal(TEXT[result.code][0], result.code, TEXT[result.code][1]);
  return NextResponse.json({ ok: true, added: result.added, removed: result.removed });
}

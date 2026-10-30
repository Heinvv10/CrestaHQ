import { locId } from "@/lib/gbp/listings";

/**
 * The canonical Google review URL for a sub-account — one seam every reader
 * uses (the review-request senders, the public /r/[token] page, the GBP page;
 * the velocity-review-pipeline can read it later).
 *
 *   configured — `googleReviewConfig.reviewUrl`: the ONLY URL a sender uses.
 *   proposed   — the selected GBP listing's `newReviewUri`: never used on its
 *                own; an admin may adopt it explicitly (POST
 *                …/google-review/adopt-listing-url, a compare-and-set).
 *
 * Per listing (MULTI_LISTING_V1_PLAN.md PR 5): with no `locationName`, or the
 * main listing's, the answer is exactly the above. For an EXTRA listing,
 * `configured` is `googleReviewConfig.listingUrls[locId]` and `proposed` that
 * listing's own `newReviewUri`; a location the sub-account does not manage
 * has neither.
 *
 * Nothing here writes, and nothing derives `configured` from `proposed`, so a
 * configured URL is never silently overwritten. Pure — safe on the client.
 */

export type ReviewUrlState = "none" | "matches" | "proposal_available" | "differs";

export interface ResolvedReviewUrl {
  configured: string | null;
  proposed: string | null;
  state: ReviewUrlState;
}

export interface ReviewUrlSource {
  googleReviewConfig?: { reviewUrl?: unknown; listingUrls?: unknown } | null;
  googleListing?: { locationName?: unknown; newReviewUri?: unknown } | null;
  googleExtraListings?: ReadonlyArray<{ locationName?: unknown; newReviewUri?: unknown }> | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function resolveReviewUrl(
  sub: ReviewUrlSource | null | undefined,
  locationName?: string | null,
): ResolvedReviewUrl {
  let configured: string | null;
  let proposed: string | null;
  if (!locationName || locationName === sub?.googleListing?.locationName) {
    configured = str(sub?.googleReviewConfig?.reviewUrl);
    proposed = str(sub?.googleListing?.newReviewUri);
  } else {
    const extra = (sub?.googleExtraListings ?? []).find((l) => l.locationName === locationName);
    const urls = sub?.googleReviewConfig?.listingUrls;
    configured = extra && urls && typeof urls === "object" ? str((urls as Record<string, unknown>)[locId(locationName)]) : null;
    proposed = extra ? str(extra.newReviewUri) : null;
  }
  const state: ReviewUrlState = !proposed
    ? "none"
    : !configured
      ? "proposal_available"
      : configured === proposed
        ? "matches"
        : "differs";
  return { configured, proposed, state };
}

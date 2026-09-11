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
  googleReviewConfig?: { reviewUrl?: unknown } | null;
  googleListing?: { newReviewUri?: unknown } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function resolveReviewUrl(sub: ReviewUrlSource | null | undefined): ResolvedReviewUrl {
  const configured = str(sub?.googleReviewConfig?.reviewUrl);
  const proposed = str(sub?.googleListing?.newReviewUri);
  const state: ReviewUrlState = !proposed
    ? "none"
    : !configured
      ? "proposal_available"
      : configured === proposed
        ? "matches"
        : "differs";
  return { configured, proposed, state };
}

import { describe, expect, it } from "vitest";
import { resolveReviewUrl } from "./canonical-url";

/**
 * The canonical review-URL seam per listing (MULTI_LISTING_V1_PLAN.md PR 5).
 * The main listing (or no location) answers exactly as before; an EXTRA
 * listing's configured link is `listingUrls[locId]` and its proposal its own
 * `newReviewUri` — never the main's, and never derived from the proposal.
 */

const MAIN = "locations/main-1";
const B = "locations/extra-b";
const MAIN_URL = "https://g.page/r/main/review";
const B_URL = "https://g.page/r/extra-b/review";
const B_PROPOSED = "https://review.fixture.example/extra-b";

const sub = (listingUrls?: Record<string, unknown>, bUri: string | null = B_PROPOSED) => ({
  googleReviewConfig: { reviewUrl: MAIN_URL, ...(listingUrls ? { listingUrls } : {}) },
  googleListing: { locationName: MAIN, newReviewUri: "https://review.fixture.example/main" },
  googleExtraListings: [{ locationName: B, newReviewUri: bUri }],
});

describe("resolveReviewUrl for a listing", () => {
  it("the main listing, or no location, is exactly today's answer", () => {
    const today = resolveReviewUrl(sub({ "extra-b": B_URL }));
    expect(today).toEqual({ configured: MAIN_URL, proposed: "https://review.fixture.example/main", state: "differs" });
    expect(resolveReviewUrl(sub({ "extra-b": B_URL }), MAIN)).toEqual(today);
    expect(resolveReviewUrl(sub({ "extra-b": B_URL }), null)).toEqual(today);
  });

  it("an extra with an adopted link: that link, and its own proposal", () => {
    expect(resolveReviewUrl(sub({ "extra-b": B_URL }), B)).toEqual({ configured: B_URL, proposed: B_PROPOSED, state: "differs" });
    expect(resolveReviewUrl(sub({ "extra-b": B_PROPOSED }), B)).toEqual({ configured: B_PROPOSED, proposed: B_PROPOSED, state: "matches" });
  });

  it("an extra with nothing adopted is never given the main's link", () => {
    expect(resolveReviewUrl(sub(), B)).toEqual({ configured: null, proposed: B_PROPOSED, state: "proposal_available" });
    expect(resolveReviewUrl(sub({ "other-loc": B_URL }), B).configured).toBeNull();
    expect(resolveReviewUrl(sub({ "extra-b": "" }), B).configured).toBeNull();
    expect(resolveReviewUrl(sub({ "extra-b": 7 }), B).configured).toBeNull();
    expect(resolveReviewUrl(sub(undefined, null), B)).toEqual({ configured: null, proposed: null, state: "none" });
  });

  it("a location the sub-account does not manage has neither link, even with a stale key", () => {
    expect(resolveReviewUrl(sub({ "extra-gone": B_URL }), "locations/extra-gone")).toEqual({ configured: null, proposed: null, state: "none" });
    expect(resolveReviewUrl(null, B)).toEqual({ configured: null, proposed: null, state: "none" });
  });
});

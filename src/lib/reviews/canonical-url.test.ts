import { describe, expect, it } from "vitest";
import { resolveReviewUrl } from "./canonical-url";

/**
 * The canonical review-URL seam. `configured` (googleReviewConfig.reviewUrl)
 * is the ONLY URL a sender uses; the selected listing's newReviewUri is only
 * ever a `proposed` value an admin may adopt explicitly.
 */

const CONFIGURED = "https://g.page/r/e2e-existing/review";
const LISTING = "https://review.fixture.example/fake-gqeberha";
const sub = (reviewUrl?: unknown, newReviewUri?: unknown) => ({
  ...(reviewUrl === undefined ? {} : { googleReviewConfig: { reviewUrl } }),
  ...(newReviewUri === undefined ? {} : { googleListing: { newReviewUri } }),
});

describe("resolveReviewUrl", () => {
  it("none — no listing link to propose, whatever is configured", () => {
    expect(resolveReviewUrl(sub())).toEqual({ configured: null, proposed: null, state: "none" });
    expect(resolveReviewUrl(sub(CONFIGURED))).toEqual({ configured: CONFIGURED, proposed: null, state: "none" });
    expect(resolveReviewUrl(sub(CONFIGURED, null))).toEqual({ configured: CONFIGURED, proposed: null, state: "none" });
  });

  it("proposal_available — a listing link and nothing configured", () => {
    expect(resolveReviewUrl(sub(undefined, LISTING))).toEqual({ configured: null, proposed: LISTING, state: "proposal_available" });
    expect(resolveReviewUrl(sub("", LISTING))).toEqual({ configured: null, proposed: LISTING, state: "proposal_available" });
  });

  it("matches — the configured link IS the listing's", () => {
    expect(resolveReviewUrl(sub(LISTING, LISTING))).toEqual({ configured: LISTING, proposed: LISTING, state: "matches" });
  });

  it("differs — both, different; the configured one stays what senders use", () => {
    expect(resolveReviewUrl(sub(CONFIGURED, LISTING))).toEqual({ configured: CONFIGURED, proposed: LISTING, state: "differs" });
  });

  it("never derives the configured URL from the listing, and ignores non-string values", () => {
    expect(resolveReviewUrl(sub(undefined, LISTING)).configured).toBeNull();
    expect(resolveReviewUrl(sub(42, 7))).toEqual({ configured: null, proposed: null, state: "none" });
    expect(resolveReviewUrl(null)).toEqual({ configured: null, proposed: null, state: "none" });
    expect(resolveReviewUrl({ googleReviewConfig: null, googleListing: null })).toEqual({ configured: null, proposed: null, state: "none" });
  });
});

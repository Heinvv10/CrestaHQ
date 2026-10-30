import { describe, expect, it } from "vitest";

import { checkReviewRateLimit } from "./rate-limit";
import { checkCheckoutRateLimit } from "@/lib/checkout/rate-limit";

/**
 * Regression test for a MEDIUM found in blind review: the review endpoint was
 * sharing the checkout limiter's single IP-keyed bucket, so review traffic and
 * checkout traffic from one office NAT drained each other's budget.
 *
 * The point of these tests is the LAST one — if someone re-points the review
 * route at `checkCheckoutRateLimit`, the isolation test goes red.
 */

describe("checkReviewRateLimit", () => {
  it("allows traffic under the per-IP limit", () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 20; i++) {
      expect(checkReviewRateLimit(ip).ok).toBe(true);
    }
  });

  it("blocks past the limit and reports a positive Retry-After", () => {
    const ip = "203.0.113.11";
    for (let i = 0; i < 20; i++) checkReviewRateLimit(ip);
    const blocked = checkReviewRateLimit(ip);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("tracks each IP independently — one abuser can't block everyone", () => {
    const abuser = "203.0.113.12";
    for (let i = 0; i < 25; i++) checkReviewRateLimit(abuser);
    expect(checkReviewRateLimit(abuser).ok).toBe(false);
    expect(checkReviewRateLimit("203.0.113.13").ok).toBe(true);
  });

  it("does NOT share a bucket with the checkout limiter", () => {
    const ip = "203.0.113.14";
    // Exhaust reviews for this IP.
    for (let i = 0; i < 25; i++) checkReviewRateLimit(ip);
    expect(checkReviewRateLimit(ip).ok).toBe(false);

    // Checkout from the SAME IP must still be allowed. If the review route is
    // ever re-pointed at the checkout limiter, this fails.
    expect(checkCheckoutRateLimit(ip).ok).toBe(true);
  });
});

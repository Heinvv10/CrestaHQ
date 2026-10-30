import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MULTI_LISTING_V1_PLAN.md H2 — the served set is read per listing: one
 * `locationName ==` query per listing, each capped at 500 records, merged
 * newest first. A busy listing can never crowd a quiet one out of the inbox,
 * and `truncated` says which reads really hit the cap.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, LOC_NORTH, SA, mem, recordingSleep, resetSync } from "@/test/gbp-sync-harness";
import { syncListing } from "./run";
import { loadServedReviews, SERVED_REVIEW_CAP } from "./served";

const ORIGINAL = { ...process.env };
const NOW = new Date();

/** `n` active, fresh records on `loc`, created at `base + i` ms. */
function seedOn(loc: string, prefix: string, n: number, base: number) {
  for (let i = 0; i < n; i++) {
    mem.seed(`subAccounts/${SA}/gbpReviews/${prefix}${i}`, {
      subAccountId: SA, locationName: loc, reviewId: `${prefix}${i}`, state: "active", starRating: 4,
      createTime: new Date(base + i), lastSeenAt: NOW, comment: null,
    });
  }
}

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("single listing: unchanged", () => {
  it("serves the listing's active reviews newest first, not truncated; no listing serves nothing", async () => {
    await syncListing(SA, { trigger: "scheduled", sleep: recordingSleep().sleep });
    const { reviews, truncated } = await loadServedReviews(SA, [LOC_A], NOW);
    expect(reviews.map((r) => r.reviewId)).toEqual(["fake-r7", "fake-r6", "fake-r5", "fake-r4", "fake-r3", "fake-r2", "fake-r1"]);
    expect(truncated).toBe(false);
    expect(await loadServedReviews(SA, [], NOW)).toEqual({ reviews: [], truncated: false });
  });

  it("exactly the cap is not truncated; one more is", async () => {
    seedOn(LOC_A, "a", SERVED_REVIEW_CAP, Date.UTC(2026, 8, 1));
    expect(await loadServedReviews(SA, [LOC_A], NOW)).toMatchObject({ truncated: false });
    seedOn(LOC_A, "z", 1, Date.UTC(2026, 7, 1));
    const { reviews, truncated } = await loadServedReviews(SA, [LOC_A], NOW);
    expect([reviews.length, truncated]).toEqual([SERVED_REVIEW_CAP, true]);
  });
});

describe("two listings", () => {
  it("501 on the busy listing never crowd out the quiet one's 3 (older) reviews", async () => {
    seedOn(LOC_A, "a", SERVED_REVIEW_CAP + 1, Date.UTC(2026, 8, 1));
    seedOn(LOC_NORTH, "n", 3, Date.UTC(2026, 6, 1));
    const both = await loadServedReviews(SA, [LOC_A, LOC_NORTH], NOW);
    expect(both.reviews.filter((r) => r.locationName === LOC_NORTH).map((r) => r.reviewId).sort()).toEqual(["n0", "n1", "n2"]);
    expect(both.reviews.filter((r) => r.locationName === LOC_A)).toHaveLength(SERVED_REVIEW_CAP);
    expect(both.truncated).toBe(true);
    // Truncation comes from the busy listing only.
    expect((await loadServedReviews(SA, [LOC_NORTH], NOW)).truncated).toBe(false);
  });

  it("merges the listings newest first, and serves only the listings asked for", async () => {
    seedOn(LOC_A, "a", 2, Date.UTC(2026, 8, 1, 0, 0, 0, 10)); // a0 @10ms, a1 @11ms
    seedOn(LOC_NORTH, "n", 3, Date.UTC(2026, 8, 1, 0, 0, 0, 9)); // n0 @9, n1 @10, n2 @11
    const ids = (await loadServedReviews(SA, [LOC_A, LOC_NORTH], NOW)).reviews.map((r) => r.reviewId);
    expect(ids.slice(0, 2).sort()).toEqual(["a1", "n2"]);
    expect(ids.slice(2, 4).sort()).toEqual(["a0", "n1"]);
    expect(ids[4]).toBe("n0");
    expect((await loadServedReviews(SA, [LOC_A], NOW)).reviews.map((r) => r.reviewId)).toEqual(["a1", "a0"]);
  });
});

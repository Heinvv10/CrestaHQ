import { describe, expect, it } from "vitest";
import { run, score } from "./reputation";
import { BUSINESS } from "./sections.fixture";

const codes = (raw: Parameters<typeof score>[0]) => score(raw).findings.map((f) => f.code);

const input = (rating: number | null, reviewsCount: number | null) => ({
  business: { ...BUSINESS, rating, reviewsCount },
  homepage: null,
  signal: new AbortController().signal,
  count: () => undefined,
});

describe("reputation score", () => {
  it("no reviews (0) scores 0 with only no_reviews", () => {
    expect(score({ rating: 4.9, reviewsCount: 0 })).toEqual({
      score: 0,
      findings: [{ code: "no_reviews", text: "There are no Google reviews yet." }],
    });
  });

  it("a null count is treated as no reviews", () => {
    expect(codes({ rating: 4.2, reviewsCount: null })).toEqual(["no_reviews"]);
  });

  it("fewer than 10 reviews is few_reviews; 10 is not", () => {
    expect(codes({ rating: 4.5, reviewsCount: 9 })).toEqual(["few_reviews"]);
    expect(codes({ rating: 4.5, reviewsCount: 10 })).toEqual([]);
  });

  it("singular review text", () => {
    expect(score({ rating: 5, reviewsCount: 1 }).findings[0]!.text).toBe("Only 1 Google review.");
  });

  it("a rating below 4.0 is low_rating; exactly 4.0 is not", () => {
    expect(codes({ rating: 3.9, reviewsCount: 40 })).toEqual(["low_rating"]);
    expect(codes({ rating: 4.0, reviewsCount: 40 })).toEqual([]);
  });

  it("weights volume 40 (capped at 50 reviews) and rating 60", () => {
    expect(score({ rating: 5, reviewsCount: 50 }).score).toBe(100);
    expect(score({ rating: 5, reviewsCount: 500 }).score).toBe(100);
    expect(score({ rating: 4, reviewsCount: 25 }).score).toBe(68);
  });

  it("without a rating, the score is volume alone", () => {
    expect(score({ rating: null, reviewsCount: 25 })).toEqual({ score: 50, findings: [] });
  });
});

describe("reputation run", () => {
  it("is unavailable with no rating data at all, still marking velocity/reply rate not measured", async () => {
    const out = await run(input(null, null));
    expect(out.status).toBe("unavailable");
    expect(out.findings).toEqual([]);
    expect(out.raw).toEqual({ velocity90d: "notMeasured", ownerReplyRate: "notMeasured" });
  });

  it("measures rating + count and never fakes velocity or reply rate", async () => {
    const out = await run(input(4.6, 37));
    expect(out.status).toBe("ok");
    expect(out.raw).toEqual({
      rating: 4.6,
      reviewsCount: 37,
      velocity90d: "notMeasured",
      ownerReplyRate: "notMeasured",
    });
  });
});

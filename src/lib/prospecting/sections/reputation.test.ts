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
      findings: [expect.objectContaining({ code: "no_reviews", text: "There are no Google reviews yet." })],
    });
  });

  it("a null count is treated as no reviews", () => {
    expect(codes({ rating: 4.2, reviewsCount: null })).toEqual(["no_reviews"]);
  });

  it("fewer than 10 reviews is few_reviews, which replaces reviews_under_50; 10–49 is reviews_under_50; 50 is neither", () => {
    expect(codes({ rating: 4.9, reviewsCount: 9 })).toEqual(["few_reviews"]);
    expect(codes({ rating: 4.9, reviewsCount: 10 })).toEqual(["reviews_under_50"]);
    expect(codes({ rating: 4.9, reviewsCount: 49 })).toEqual(["reviews_under_50"]);
    expect(codes({ rating: 4.9, reviewsCount: 50 })).toEqual([]);
  });

  it("singular review text", () => {
    expect(score({ rating: 5, reviewsCount: 1 }).findings[0]!.text).toBe(
      "Only 1 Google review, too few for people to trust the business over one with dozens.",
    );
  });

  it("each finding's text reads as a problem, not a bare fact", () => {
    expect(score({ rating: 4.5, reviewsCount: 33 }).findings.map((f) => f.text)).toEqual([
      "Only 33 Google reviews: businesses with 50 or more get picked first.",
      "The Google rating is 4.5 out of 5, below the 4.8 that wins close calls.",
    ]);
    expect(score({ rating: 3.5, reviewsCount: 60 }).findings[0]!.text).toBe(
      "The Google rating is 3.5 out of 5, below the 4.0 many people will not look past.",
    );
  });

  it("a rating below 4.0 is low_rating, which replaces rating_under_4_8; 4.0–4.7 is rating_under_4_8; 4.8 is neither", () => {
    expect(codes({ rating: 3.9, reviewsCount: 60 })).toEqual(["low_rating"]);
    expect(codes({ rating: 4.0, reviewsCount: 60 })).toEqual(["rating_under_4_8"]);
    expect(codes({ rating: 4.7, reviewsCount: 60 })).toEqual(["rating_under_4_8"]);
    expect(codes({ rating: 4.8, reviewsCount: 60 })).toEqual([]);
  });

  it("scores 100 minus the deductions", () => {
    expect(score({ rating: 5, reviewsCount: 50 }).score).toBe(100);
    expect(score({ rating: 4.6, reviewsCount: 37 }).score).toBe(75);
    expect(score({ rating: 3.5, reviewsCount: 5 }).score).toBe(10);
  });

  it("without a rating, only the count can deduct", () => {
    expect(codes({ rating: null, reviewsCount: 25 })).toEqual(["reviews_under_50"]);
    expect(score({ rating: null, reviewsCount: 60 })).toEqual({ score: 100, findings: [] });
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

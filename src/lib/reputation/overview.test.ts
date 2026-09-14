import { describe, expect, it } from "vitest";
import { computeOverview, parseRange, type OverviewRequestInput, type OverviewReviewInput } from "./overview";

/**
 * The Reputation overview numbers (SP5 a) — pure. The route test proves the
 * same numbers come out of the real route over seeded docs.
 */

const NOW = new Date("2026-09-14T10:00:00Z"); // a Monday
const DAY = 24 * 3600_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3600_000);

const rev = (stars: number, created: Date, replyAfterHours?: number | "missing"): OverviewReviewInput => ({
  starRating: stars,
  createTime: created,
  reply:
    replyAfterHours === undefined
      ? null
      : { updateTime: replyAfterHours === "missing" ? undefined : new Date(created.getTime() + replyAfterHours * 3600_000).toISOString() },
});
const req = (channel: string, sent: Date, more: Partial<OverviewRequestInput> = {}): OverviewRequestInput => ({
  channel, sentAt: sent, status: "sent", source: "dispatcher", ...more,
});

function overview(over: Partial<Parameters<typeof computeOverview>[0]> = {}) {
  return computeOverview({ reviews: [], requests: [], oldestRequestAt: null, range: "90d", now: NOW, ...over });
}

describe("parseRange", () => {
  it("defaults to 90d and accepts only the presets", () => {
    expect(parseRange(null)).toBe("90d");
    expect(parseRange("")).toBe("90d");
    for (const p of ["30d", "90d", "365d", "all"]) expect(parseRange(p)).toBe(p);
    for (const bad of ["7d", "90", "ALL", "30d "]) expect(parseRange(bad)).toBeNull();
  });
});

describe("range bounds and buckets", () => {
  it("30d: the last 30 days against the 30 before, weekly buckets", () => {
    const o = overview({ range: "30d" });
    expect(o.range).toEqual({
      preset: "30d", bucket: "week",
      from: ago(30).toISOString(), to: NOW.toISOString(), previousFrom: ago(60).toISOString(),
    });
  });

  it("365d: monthly buckets starting on the 1st, UTC", () => {
    const o = overview({ range: "365d" });
    expect(o.range.bucket).toBe("month");
    expect(o.trend[0].start).toBe("2025-09-01T00:00:00.000Z");
    expect(o.trend.at(-1)!.start).toBe("2026-09-01T00:00:00.000Z");
    expect(o.trend).toHaveLength(13);
  });

  it("weekly buckets start on Monday 00:00 UTC and are contiguous, empty ones included", () => {
    const o = overview({ range: "30d", reviews: [rev(5, ago(1))] });
    const starts = o.trend.map((b) => b.start);
    expect(starts[0]).toBe("2026-08-10T00:00:00.000Z"); // the Monday on or before 2026-08-15
    expect(starts.at(-1)).toBe("2026-09-14T00:00:00.000Z");
    expect(starts).toHaveLength(6);
    for (let i = 1; i < starts.length; i++) expect(Date.parse(starts[i]) - Date.parse(starts[i - 1])).toBe(7 * DAY);
    expect(o.trend.filter((b) => b.reviews === 0)).toHaveLength(5);
  });

  it("all: starts at the oldest review or request, no previous period", () => {
    const o = overview({ range: "all", reviews: [rev(4, ago(40))], requests: [req("sms", ago(50))], oldestRequestAt: ago(50) });
    expect(o.range.from).toBe(ago(50).toISOString());
    expect(o.range.previousFrom).toBeNull();
    expect(o.range.bucket).toBe("week");
    expect(o.reviews!.previous).toBeNull();
    expect(o.requests.previous).toBeNull();
    expect(overview({ range: "all", reviews: [rev(4, ago(200))] }).range.bucket).toBe("month");
  });

  it("all with nothing at all is an empty range ending now", () => {
    const o = overview({ range: "all" });
    expect(o.range.from).toBe(NOW.toISOString());
    expect(o.trend).toHaveLength(1);
  });
});

describe("reviews", () => {
  const reviews = [
    rev(5, ago(1), 3), rev(2, ago(10)), rev(3, ago(20)), rev(5, ago(30), 5), rev(4, ago(45), 1), // in 90d
    rev(1, ago(100)), rev(5, ago(120)), // previous 90d
    rev(3, ago(200)), // neither
  ];

  it("counts and averages the range, and the equal-length range before it", () => {
    const r = overview({ reviews }).reviews!;
    expect(r.count).toBe(5);
    expect(r.avgRating).toBeCloseTo(19 / 5);
    expect(r.previous).toEqual({ count: 2, avgRating: 3 });
  });

  it("previous is null when the range before had no reviews", () => {
    expect(overview({ reviews: [rev(5, ago(1))] }).reviews!.previous).toBeNull();
  });

  it("star distribution counts each rating in range", () => {
    expect(overview({ reviews }).reviews!.distribution).toEqual({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 2 });
  });

  it("an empty range has no average and no coverage — never 0", () => {
    const r = overview({ reviews: [rev(1, ago(100))] }).reviews!;
    expect(r).toMatchObject({ count: 0, avgRating: null, response: { replied: 0, unreplied: 0, coverage: null } });
    expect(r.response.replyHours).toEqual({ avg: null, median: null, counted: 0, excluded: 0 });
  });

  it("skips reviews with no usable createTime, and future ones", () => {
    const r = overview({ reviews: [rev(5, ago(1)), { starRating: 1, createTime: "not a date", reply: null }, rev(1, new Date(NOW.getTime() + DAY))] }).reviews!;
    expect(r.count).toBe(1);
  });

  it("a review exactly at `now` or exactly at `from` is in range", () => {
    expect(overview({ range: "30d", reviews: [rev(5, NOW), rev(4, ago(30))] }).reviews!.count).toBe(2);
  });
});

describe("response", () => {
  it("coverage = replied ÷ reviews in range", () => {
    // Asymmetric on purpose: 1 of 4 — replied/total and unreplied/total differ.
    const r = overview({ reviews: [rev(5, ago(1), 2), rev(4, ago(2)), rev(3, ago(3)), rev(2, ago(4))] }).reviews!.response;
    expect(r).toMatchObject({ replied: 1, unreplied: 3, coverage: 0.25 });
  });

  it("time to latest reply: average and median over replied reviews, bad values excluded and counted", () => {
    const r = overview({
      reviews: [rev(5, ago(1), 2), rev(4, ago(2), 4), rev(3, ago(3), 30), rev(2, ago(4), -5), rev(1, ago(5), "missing")],
    }).reviews!.response;
    // A reply with a bad time is still a reply for coverage.
    expect(r.replied).toBe(5);
    expect(r.replyHours).toEqual({ avg: 12, median: 4, counted: 3, excluded: 2 });
  });

  it("median of an even count is the mean of the middle two", () => {
    const r = overview({ reviews: [rev(5, ago(1), 2), rev(4, ago(2), 4), rev(3, ago(3), 10), rev(2, ago(4), 100)] }).reviews!.response;
    expect(r.replyHours.median).toBe(7);
  });
});

describe("trend", () => {
  it("per bucket: review count, average rating (null when empty), reply time and requests", () => {
    const o = overview({
      range: "30d",
      reviews: [rev(5, ago(0, 1), 2), rev(3, ago(0, 2)), rev(4, ago(6), 6)],
      requests: [req("sms", ago(0, 3)), req("sms", ago(0, 4)), req("whatsapp_template", ago(6))],
      oldestRequestAt: ago(6),
    });
    const last = o.trend.at(-1)!;
    expect(last).toEqual({ start: "2026-09-14T00:00:00.000Z", reviews: 2, avgRating: 4, avgReplyHours: 2, requests: 2 });
    expect(o.trend.at(-2)).toEqual({ start: "2026-09-07T00:00:00.000Z", reviews: 1, avgRating: 4, avgReplyHours: 6, requests: 1 });
    expect(o.trend[0]).toMatchObject({ reviews: 0, avgRating: null, avgReplyHours: null, requests: 0 });
  });
});

describe("requests", () => {
  it("sent in range, by channel and by source, counting since the oldest log entry", () => {
    const o = overview({
      requests: [
        req("sms", ago(1)),
        req("email", ago(2), { source: "broadcast" }),
        req("sms", ago(5), { source: "workflow" }),
        req("whatsapp", ago(6), { source: "inbox" }),
        req("sms", ago(95)),
      ],
      oldestRequestAt: ago(95),
    });
    expect(o.requests).toEqual({
      sent: 4,
      byChannel: { sms: 2, email: 1, whatsapp: 1 },
      bySource: { dispatcher: 1, broadcast: 1, workflow: 1, inbox: 1 },
      failed: 0,
      tracked: 0,
      clicked: 0,
      previous: null, // the log does not cover the whole previous 90 days
      countingSince: ago(95).toISOString(),
    });
  });

  it("clicked counts only tracked, sent requests in range (SP5 d2)", () => {
    const o = overview({
      requests: [
        req("sms", ago(1), { tracked: true, clickedAt: ago(0, 2) }),
        req("sms", ago(2), { tracked: true, clickedAt: null }),
        req("sms", ago(3), { tracked: false, clickedAt: ago(2) }),
        req("sms", ago(4), { tracked: true, clickedAt: ago(3), status: "failed" }),
        req("sms", ago(200), { tracked: true, clickedAt: ago(199) }),
      ],
      oldestRequestAt: ago(200),
    });
    expect(o.requests).toMatchObject({ sent: 3, tracked: 2, clicked: 1 });
  });

  it("failed sends are not requests sent: counted apart, never in the trend", () => {
    const o = overview({
      requests: [req("sms", ago(0, 1)), req("sms", ago(0, 2), { status: "failed", source: "workflow" })],
      oldestRequestAt: ago(0, 2),
    });
    expect(o.requests).toMatchObject({ sent: 1, failed: 1, byChannel: { sms: 1 }, bySource: { dispatcher: 1 } });
    expect(o.trend.at(-1)?.requests).toBe(1);
  });

  it("rows written before d1 (WhatsApp modes, no source) read as whatsapp / dispatcher", () => {
    const legacy = (channel: string) => ({ channel, sentAt: ago(1), status: "sent" });
    const o = overview({ requests: [legacy("whatsapp_template"), legacy("whatsapp_manual")], oldestRequestAt: ago(1) });
    expect(o.requests).toMatchObject({ sent: 2, byChannel: { whatsapp: 2 }, bySource: { dispatcher: 2 } });
  });

  it("previous is given only when the log covers the whole previous range", () => {
    const o = overview({ range: "30d", requests: [req("sms", ago(1)), req("sms", ago(40))], oldestRequestAt: ago(61) });
    expect(o.requests.previous).toEqual({ sent: 1 });
  });

  it("no log at all: nothing counted, countingSince null", () => {
    expect(overview().requests).toEqual({ sent: 0, byChannel: {}, bySource: {}, failed: 0, tracked: 0, clicked: 0, previous: null, countingSince: null });
  });
});

describe("without review data (gate off / not connected)", () => {
  it("reviews is null and the trend's review fields are null, requests still counted", () => {
    const o = overview({ reviews: null, requests: [req("sms", ago(0, 1))], oldestRequestAt: ago(0, 1) });
    expect(o.reviews).toBeNull();
    expect(o.requests.sent).toBe(1);
    expect(o.trend.at(-1)).toMatchObject({ reviews: null, avgRating: null, avgReplyHours: null, requests: 1 });
  });
});

describe("sentiment (SP5 b)", () => {
  const labelled = (stars: number, at: Date, label: string | null): OverviewReviewInput => ({
    ...rev(stars, at),
    sentiment: label ? { label } : null,
  });

  it("counts labels over the reviews in range; unlabelled ones are 'not analysed yet'", () => {
    const o = overview({
      reviews: [
        labelled(5, ago(1), "positive"), labelled(4, ago(2), "positive"), labelled(3, ago(3), "neutral"),
        labelled(1, ago(4), "negative"), labelled(2, ago(5), null), labelled(5, ago(120), "negative"),
      ],
    });
    expect(o.reviews!.sentiment).toEqual({ positive: 2, neutral: 1, negative: 1, notAnalysed: 1, failed: 0 });
  });

  it("'couldn't be analysed' (given up after failures) is counted apart from 'not analysed yet'", () => {
    const o = overview({
      reviews: [{ ...labelled(3, ago(1), null), sentimentGaveUp: true }, labelled(2, ago(2), null), { ...labelled(5, ago(3), "positive"), sentimentGaveUp: true }],
    });
    // A label wins over an old failure record.
    expect(o.reviews!.sentiment).toEqual({ positive: 1, neutral: 0, negative: 0, notAnalysed: 1, failed: 1 });
  });

  it("an unknown label is not counted as any of the three", () => {
    const o = overview({ reviews: [labelled(5, ago(1), "ecstatic")] });
    expect(o.reviews!.sentiment).toEqual({ positive: 0, neutral: 0, negative: 0, notAnalysed: 1, failed: 0 });
  });
});

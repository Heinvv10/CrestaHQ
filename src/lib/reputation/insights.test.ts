import { describe, expect, it } from "vitest";

import { parseDailyMetrics } from "@/lib/gbp/provider/google-parse";
import { insightsWindow, parseInsightsRange, summarizeInsights } from "./insights";

/**
 * The Insights numbers (SP5 G2) — pure: windows, totals, previous-period
 * totals, the tile groups and the daily series the page draws.
 */

const NOW = new Date("2026-09-14T10:00:00Z");

describe("ranges and windows", () => {
  it("defaults to 28d and refuses anything but 7d / 28d / 90d", () => {
    expect(parseInsightsRange(null)).toBe("28d");
    expect(parseInsightsRange("")).toBe("28d");
    for (const r of ["7d", "28d", "90d"]) expect(parseInsightsRange(r)).toBe(r);
    for (const bad of ["30d", "all", "7", "1y", "28D"]) expect(parseInsightsRange(bad)).toBeNull();
  });

  it("ends YESTERDAY (UTC) — today is still being counted — and compares with the equal span before", () => {
    expect(insightsWindow("7d", NOW)).toEqual({
      current: { start: "2026-09-07", end: "2026-09-13" },
      previous: { start: "2026-08-31", end: "2026-09-06" },
    });
    expect(insightsWindow("28d", NOW)).toEqual({
      current: { start: "2026-08-17", end: "2026-09-13" },
      previous: { start: "2026-07-20", end: "2026-08-16" },
    });
    expect(insightsWindow("90d", NOW).current).toEqual({ start: "2026-06-16", end: "2026-09-13" });
    expect(insightsWindow("90d", NOW).previous).toEqual({ start: "2026-03-18", end: "2026-06-15" });
  });
});

describe("summarizeInsights", () => {
  const window = insightsWindow("7d", NOW);
  const day = (date: string, value: number) => ({ date, value });
  const series = {
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [day("2026-09-01", 100), day("2026-09-07", 3), day("2026-09-13", 4)],
    BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [day("2026-09-07", 10), day("2026-09-08", 20)],
    BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [day("2026-09-09", 5)],
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: [day("2026-08-31", 7), day("2026-09-09", 6)],
    CALL_CLICKS: [day("2026-09-10", 2), day("2026-09-06", 9)],
    WEBSITE_CLICKS: [day("2026-09-11", 1)],
    BUSINESS_DIRECTION_REQUESTS: [],
    BUSINESS_CONVERSATIONS: [day("2026-09-12", 0)],
    BUSINESS_BOOKINGS: [],
  };
  const s = summarizeInsights(series, window);

  it("totals each metric over the current window and the previous one, separately", () => {
    expect(s.totals).toMatchObject({
      BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 7, BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 30, BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 5,
      BUSINESS_IMPRESSIONS_MOBILE_MAPS: 6, CALL_CLICKS: 2, WEBSITE_CLICKS: 1, BUSINESS_DIRECTION_REQUESTS: 0, BUSINESS_CONVERSATIONS: 0, BUSINESS_BOOKINGS: 0,
    });
    expect(s.previousTotals).toMatchObject({ BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 100, BUSINESS_IMPRESSIONS_MOBILE_MAPS: 7, CALL_CLICKS: 9, WEBSITE_CLICKS: 0 });
  });

  it("groups them into the tiles: search / maps views, calls, website, directions, conversations, bookings, desktop / mobile", () => {
    expect(s.groups).toEqual({
      searchViews: { current: 37, previous: 100 },
      mapsViews: { current: 11, previous: 7 },
      calls: { current: 2, previous: 9 },
      websiteClicks: { current: 1, previous: 0 },
      directions: { current: 0, previous: 0 },
      conversations: { current: 0, previous: 0 },
      bookings: { current: 0, previous: 0 },
      desktopViews: { current: 12, previous: 100 },
      mobileViews: { current: 36, previous: 7 },
    });
  });

  it("draws one point per day of the current window, a missing day as 0", () => {
    expect(s.daily.map((d) => d.date)).toEqual(["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]);
    expect(s.daily[0]).toEqual({ date: "2026-09-07", searchViews: 13, mapsViews: 0, calls: 0, websiteClicks: 0, directions: 0, desktopViews: 3, mobileViews: 10 });
    expect(s.daily[2]).toMatchObject({ mapsViews: 11, desktopViews: 5, mobileViews: 6 });
  });

  it("says how far Google's data reaches: the latest date Google RETURNED, a genuine 0 included", () => {
    expect(s.lastDataDate).toBe("2026-09-13");
    // A quiet last day (value omitted by Google → 0) is still a reported day.
    expect(summarizeInsights({ CALL_CLICKS: [day("2026-09-08", 1), day("2026-09-12", 0)] }, window).lastDataDate).toBe("2026-09-12");
    expect(summarizeInsights({ CALL_CLICKS: [day("2026-09-13", 0)], WEBSITE_CLICKS: [day("2026-09-10", 0)] }, window).lastDataDate).toBe("2026-09-13");
    // A day after the window is not "data through" it.
    expect(summarizeInsights({ CALL_CLICKS: [day("2026-09-10", 0), day("2026-09-14", 3)] }, window).lastDataDate).toBe("2026-09-10");
    expect(summarizeInsights({}, window).lastDataDate).toBeNull();
    expect(summarizeInsights({ CALL_CLICKS: [] }, window).lastDataDate).toBeNull();
  });

  it("end to end from Google's payload: a last day sent without a value still counts as reported", () => {
    const series = parseDailyMetrics(
      { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [
        { date: { year: 2026, month: 9, day: 12 }, value: "4" },
        { date: { year: 2026, month: 9, day: 13 } },
      ] } }] }] },
      ["CALL_CLICKS"],
    );
    const t = summarizeInsights(series, window);
    expect(t.lastDataDate).toBe("2026-09-13");
    expect(t.totals.CALL_CLICKS).toBe(4);
  });

  it("ignores values outside both windows and never double-counts a day Google repeats", () => {
    const t = summarizeInsights({ CALL_CLICKS: [day("2026-09-14", 50), day("2026-08-01", 50), day("2026-09-08", 2), day("2026-09-08", 2)] }, window);
    expect(t.totals.CALL_CLICKS).toBe(2);
    expect(t.previousTotals.CALL_CLICKS).toBe(0);
  });
});

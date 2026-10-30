import { afterEach, describe, expect, it, vi } from "vitest";

import { googleGbpProvider as g } from "./google";
import { GBP_DAILY_METRICS, GbpProviderError, type GbpDailyMetric } from "./types";

/**
 * fetchDailyMetrics on the real provider, with only `fetch` stubbed. The
 * endpoint and shapes were checked on developers.google.com on 2026-09-14
 * (Business Profile Performance API v1, locations.fetchMultiDailyMetricsTimeSeries;
 * DatedValue.value is an int64 string, "not present when the value is zero").
 */

const TOKEN = "ya29.DataAccessToken";
const LOC = "locations/222";
type Opts = { metrics: GbpDailyMetric[]; startDate: string; endDate: string };
const OPTS: Opts = { metrics: ["CALL_CLICKS", "WEBSITE_CLICKS"], startDate: "2026-08-30", endDate: "2026-09-02" };

function stub(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}
const opts = (over: Partial<Opts> = {}): Opts => ({ ...OPTS, metrics: [...OPTS.metrics], ...over });
async function kindOf(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GbpProviderError);
  return (e as GbpProviderError).kind;
}
const dated = (y: number, m: number, d: number, value?: string) => ({ date: { year: y, month: m, day: d }, ...(value === undefined ? {} : { value }) });

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("GETs fetchMultiDailyMetricsTimeSeries with each metric repeated and the date range split into y/m/d", async () => {
    const spy = stub(200, {});
    await g.fetchDailyMetrics(TOKEN, LOC, opts());
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(
      "https://businessprofileperformance.googleapis.com/v1/locations/222:fetchMultiDailyMetricsTimeSeries" +
        "?dailyMetrics=CALL_CLICKS&dailyMetrics=WEBSITE_CLICKS" +
        "&dailyRange.startDate.year=2026&dailyRange.startDate.month=8&dailyRange.startDate.day=30" +
        "&dailyRange.endDate.year=2026&dailyRange.endDate.month=9&dailyRange.endDate.day=2",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it.each([
    ["a location name with an extra segment", { loc: "locations/222/../x" }],
    ["an account-scoped name", { loc: "accounts/1/locations/222" }],
    ["a malformed start date", { startDate: "2026-8-30" }],
    ["an unknown metric", { metrics: ["BUSINESS_FOOD_ORDERS"] }],
    ["no metrics", { metrics: [] }],
  ])("refuses %s before any request", async (_label, bad) => {
    const spy = stub(200, {});
    const { loc, ...rest } = bad as { loc?: string } & Record<string, unknown>;
    await expect(g.fetchDailyMetrics(TOKEN, loc ?? LOC, opts(rest as Partial<Opts>))).rejects.toThrow(TypeError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("knows the nine metrics the Insights tab reads", () => {
    expect([...GBP_DAILY_METRICS]).toEqual([
      "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
      "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS",
      "BUSINESS_CONVERSATIONS", "BUSINESS_BOOKINGS",
    ]);
  });
});

describe("response", () => {
  it("maps each metric's datedValues to {date, value}; an absent value is 0; int64 strings become numbers", async () => {
    stub(200, {
      multiDailyMetricTimeSeries: [
        {
          dailyMetricTimeSeries: [
            { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [dated(2026, 8, 30, "3"), dated(2026, 8, 31), dated(2026, 9, 1, "12")] } },
            { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [dated(2026, 9, 2, "1")] } },
          ],
        },
      ],
    });
    expect(await g.fetchDailyMetrics(TOKEN, LOC, opts())).toEqual({
      CALL_CLICKS: [
        { date: "2026-08-30", value: 3 },
        { date: "2026-08-31", value: 0 },
        { date: "2026-09-01", value: 12 },
      ],
      WEBSITE_CLICKS: [{ date: "2026-09-02", value: 1 }],
    });
  });

  it("gives every requested metric a series — [] when Google sent none, or an empty body", async () => {
    stub(200, {});
    expect(await g.fetchDailyMetrics(TOKEN, LOC, opts())).toEqual({ CALL_CLICKS: [], WEBSITE_CLICKS: [] });
  });

  it("ignores a metric it did not ask for", async () => {
    stub(200, { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "BUSINESS_FOOD_ORDERS", timeSeries: { datedValues: [dated(2026, 9, 1, "9")] } }] }] });
    expect(await g.fetchDailyMetrics(TOKEN, LOC, opts())).toEqual({ CALL_CLICKS: [], WEBSITE_CLICKS: [] });
  });

  it.each([
    ["a non-numeric value", { value: "lots" }],
    ["a negative value", { value: "-1" }],
    ["a numeric (not string) value", { value: 4 }],
    ["a date without a day (a month bucket)", { date: { year: 2026, month: 9 } }],
  ])("fails closed as malformed on %s", async (_label, over) => {
    stub(200, { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ ...dated(2026, 9, 1, "1"), ...over }] } }] }] });
    expect(await kindOf(g.fetchDailyMetrics(TOKEN, LOC, opts()))).toBe("malformed");
  });

  it("a quota-0 429 is access_not_approved", async () => {
    stub(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ metadata: { quota_limit_value: "0" } }] } });
    expect(await kindOf(g.fetchDailyMetrics(TOKEN, LOC, opts()))).toBe("access_not_approved");
  });
});

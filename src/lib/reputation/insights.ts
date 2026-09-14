import { GBP_DAILY_METRICS, type GbpDailyMetric, type GbpDailySeries } from "@/lib/gbp/provider/types";

/**
 * The Reputation → Insights numbers (SP5 G2) — pure, so every figure the tab
 * shows is unit-tested here and the route only feeds it.
 *
 *   - range: the last 7 / 28 / 90 whole days ending YESTERDAY (UTC) — today
 *     is still being counted at Google — compared with the equal span before.
 *   - a day Google returns without a value is 0 (Google omits zeros) but IS a
 *     reported day; a day it does not return at all is drawn as 0 too, and
 *     `lastDataDate` — the latest date Google returned, in or before the
 *     current window — says how far its data reaches (Google reports with a lag).
 *   - views are Google's impressions: unique users per day, per surface.
 */

export const INSIGHTS_RANGES = ["7d", "28d", "90d"] as const;
export type InsightsRange = (typeof INSIGHTS_RANGES)[number];
const DAYS: Record<InsightsRange, number> = { "7d": 7, "28d": 28, "90d": 90 };
const DAY_MS = 86_400_000;

/** `null`/empty → the default; anything else that is not a preset → null (the route's 400). */
export function parseInsightsRange(v: string | null): InsightsRange | null {
  if (v === null || v === "") return "28d";
  return (INSIGHTS_RANGES as readonly string[]).includes(v) ? (v as InsightsRange) : null;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface InsightsWindow {
  current: { start: string; end: string };
  previous: { start: string; end: string };
}

export function insightsWindow(range: InsightsRange, now: Date): InsightsWindow {
  const n = DAYS[range];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
  const start = end - (n - 1) * DAY_MS;
  return {
    current: { start: iso(start), end: iso(end) },
    previous: { start: iso(start - n * DAY_MS), end: iso(start - DAY_MS) },
  };
}

type Totals = Record<GbpDailyMetric, number>;
type Pair = { current: number; previous: number };
export interface InsightsGroups {
  searchViews: Pair;
  mapsViews: Pair;
  calls: Pair;
  websiteClicks: Pair;
  directions: Pair;
  conversations: Pair;
  bookings: Pair;
  desktopViews: Pair;
  mobileViews: Pair;
}
export interface InsightsDay {
  date: string;
  searchViews: number;
  mapsViews: number;
  calls: number;
  websiteClicks: number;
  directions: number;
  desktopViews: number;
  mobileViews: number;
}
export interface InsightsSummary {
  totals: Totals;
  previousTotals: Totals;
  groups: InsightsGroups;
  daily: InsightsDay[];
  lastDataDate: string | null;
}

/** Each tile = the sum of these metrics. */
const GROUPS: Record<keyof InsightsGroups, GbpDailyMetric[]> = {
  searchViews: ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"],
  mapsViews: ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS"],
  calls: ["CALL_CLICKS"],
  websiteClicks: ["WEBSITE_CLICKS"],
  directions: ["BUSINESS_DIRECTION_REQUESTS"],
  conversations: ["BUSINESS_CONVERSATIONS"],
  bookings: ["BUSINESS_BOOKINGS"],
  desktopViews: ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS"],
  mobileViews: ["BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_MAPS"],
};
const DAILY_KEYS = ["searchViews", "mapsViews", "calls", "websiteClicks", "directions", "desktopViews", "mobileViews"] as const;

function days(start: string, end: string): string[] {
  const out: string[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += DAY_MS) out.push(iso(ms));
  return out;
}

export function summarizeInsights(series: GbpDailySeries, window: InsightsWindow): InsightsSummary {
  // date → value per metric; a repeated day keeps its last value, never adds.
  const byDate = new Map<GbpDailyMetric, Map<string, number>>();
  let lastDataDate: string | null = null;
  for (const metric of GBP_DAILY_METRICS) {
    const m = new Map<string, number>();
    for (const { date, value } of series[metric] ?? []) {
      m.set(date, value);
      if (date <= window.current.end && (lastDataDate === null || date > lastDataDate)) lastDataDate = date;
    }
    byDate.set(metric, m);
  }
  const value = (metric: GbpDailyMetric, date: string) => byDate.get(metric)?.get(date) ?? 0;
  const current = days(window.current.start, window.current.end);
  const previous = days(window.previous.start, window.previous.end);
  const sum = (dates: string[]) =>
    Object.fromEntries(GBP_DAILY_METRICS.map((m) => [m, dates.reduce((n, d) => n + value(m, d), 0)])) as Totals;
  const totals = sum(current);
  const previousTotals = sum(previous);
  const pick = (t: Totals, metrics: GbpDailyMetric[]) => metrics.reduce((n, m) => n + t[m], 0);

  const groups = Object.fromEntries(
    Object.entries(GROUPS).map(([key, metrics]) => [key, { current: pick(totals, metrics), previous: pick(previousTotals, metrics) }]),
  ) as unknown as InsightsGroups;
  const daily = current.map((date) => {
    const point = { date } as InsightsDay;
    for (const key of DAILY_KEYS) point[key] = GROUPS[key].reduce((n, m) => n + value(m, date), 0);
    return point;
  });
  return { totals, previousTotals, groups, daily, lastDataDate };
}

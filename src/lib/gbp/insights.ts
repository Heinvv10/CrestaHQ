import "server-only";

import { insightsWindow, summarizeInsights, type InsightsRange, type InsightsSummary, type InsightsWindow } from "@/lib/reputation/insights";
import { withGbpAccess } from "./access";
import { discoverLocations } from "./discovery";
import { GBP_DAILY_METRICS } from "./provider/types";

/**
 * Business Profile Performance insights for one location (SP5 G2), fetched
 * from Google on demand and kept ONLY in memory — never in Firestore (the
 * Business Profile content rule: nothing stored past 30 days, so nothing is
 * stored at all). One provider call per request covers both windows.
 *
 * The memo is per sub-account + connection (its `connectedAt`) + location +
 * range + window end, for 10 minutes, per instance. An entry for a location
 * other than the listing exists only after discovery proved this connection
 * can see it, and a reconnect changes the key — so a hit never skips a check
 * that the same connection has not already passed. Refusals are never kept.
 */

export const INSIGHTS_MEMO_MS = 10 * 60_000;
const MAX_MEMO = 500;

export interface InsightsBody extends InsightsSummary {
  location: { name: string; title: string; isListing: boolean };
  range: InsightsRange;
  window: InsightsWindow;
}

/** The location is not one this connection can be shown insights for. */
export class InsightsLocationRefusal extends Error {
  constructor(readonly code: "unknown_location" | "unverifiable_truncated") {
    super(code);
    this.name = "InsightsLocationRefusal";
  }
}

const memo = new Map<string, { at: number; body: InsightsBody }>();

/** Tests only: each test starts with an empty memo. */
export function resetInsightsMemo(): void {
  memo.clear();
}

export async function loadInsights(opts: {
  subAccountId: string;
  connectionKey: string;
  listing: { locationName: string; title: string };
  locationName: string;
  range: InsightsRange;
  now: Date;
}): Promise<InsightsBody> {
  const { subAccountId, listing, locationName, range, now } = opts;
  const window = insightsWindow(range, now);
  const key = [subAccountId, opts.connectionKey, locationName, range, window.current.end].join("|");
  const hit = memo.get(key);
  if (hit && now.getTime() - hit.at < INSIGHTS_MEMO_MS) return hit.body;

  const isListing = locationName === listing.locationName;
  const { title, series } = await withGbpAccess(subAccountId, async (provider, token) => {
    let title = listing.title;
    if (!isListing) {
      const { accounts, truncated } = await discoverLocations(provider, token);
      const seen = accounts.flatMap((a) => a.locations).find((l) => l.name === locationName);
      if (!seen) throw new InsightsLocationRefusal(truncated ? "unverifiable_truncated" : "unknown_location");
      title = seen.title;
    }
    const series = await provider.fetchDailyMetrics(token, locationName, {
      metrics: [...GBP_DAILY_METRICS],
      startDate: window.previous.start,
      endDate: window.current.end,
    });
    return { title, series };
  });

  const body: InsightsBody = { location: { name: locationName, title, isListing }, range, window, ...summarizeInsights(series, window) };
  memo.set(key, { at: now.getTime(), body });
  while (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value!);
  return body;
}

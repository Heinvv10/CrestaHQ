import { AreaChart, BarChart } from "@/components/reports/charts";
import type { InsightsGroups, InsightsRange } from "@/lib/reputation/insights";
import { fmtDelta } from "./format";
import { Card } from "./overview-tiles";

/**
 * Insights tiles, daily charts and the desktop / mobile split — pure
 * presentation; every number is computed and unit-tested in
 * lib/reputation/insights.ts.
 */

export interface InsightsData {
  location: { name: string; title: string; isListing: boolean };
  range: InsightsRange;
  window: { current: { start: string; end: string }; previous: { start: string; end: string } };
  lastDataDate: string | null;
  groups: InsightsGroups;
  daily: Array<{ date: string; searchViews: number; mapsViews: number; calls: number; websiteClicks: number; directions: number }>;
}

export const RANGE_TEXT: Record<InsightsRange, string> = { "7d": "Last 7 days", "28d": "Last 28 days", "90d": "Last 90 days" };
const PREVIOUS: Record<InsightsRange, string> = { "7d": "previous 7 days", "28d": "previous 28 days", "90d": "previous 90 days" };

const num = (n: number) => n.toLocaleString("en-US");
/** Google dates are calendar days: label them as such, never shifted by the viewer's zone. */
export const fmtDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const TILES: Array<{ key: keyof InsightsGroups; label: string; optional?: boolean }> = [
  { key: "searchViews", label: "Search views" },
  { key: "mapsViews", label: "Maps views" },
  { key: "calls", label: "Calls" },
  { key: "websiteClicks", label: "Website clicks" },
  { key: "directions", label: "Direction requests" },
  { key: "conversations", label: "Conversations", optional: true },
  { key: "bookings", label: "Bookings", optional: true },
];

export function InsightsTiles({ data }: { data: InsightsData }) {
  const shown = TILES.filter((t) => !t.optional || data.groups[t.key].current > 0 || data.groups[t.key].previous > 0);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="rep-insights-tiles">
      {shown.map(({ key, label }) => {
        const { current, previous } = data.groups[key];
        const id = `rep-insights-tile-${key}`;
        return (
          <div key={key} className="rounded-2xl border bg-card p-4" data-testid={id}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold" data-testid={`${id}-value`}>{num(current)}</p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`${id}-note`}>
              {fmtDelta(current - previous)} vs {PREVIOUS[data.range]}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function InsightsCharts({ data }: { data: InsightsData }) {
  const label = (date: string) => fmtDay(date).replace(/ \d{4}$/, "");
  const { desktopViews: desktop, mobileViews: mobile } = data.groups;
  const all = desktop.current + mobile.current;
  const share = (n: number) => (all === 0 ? "—" : `${Math.round((n / all) * 100)}%`);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card testId="rep-insights-chart-views" title="Views per day (Search + Maps)">
        <AreaChart data={data.daily.map((d) => ({ x: label(d.date), y: d.searchViews + d.mapsViews }))} tone="indigo" />
      </Card>
      <Card testId="rep-insights-chart-actions" title="Actions per day (calls, website, directions)">
        <BarChart data={data.daily.map((d) => ({ x: label(d.date), y: d.calls + d.websiteClicks + d.directions }))} tone="emerald" />
      </Card>
      <Card testId="rep-insights-devices" title="Views by device">
        <p className="text-sm">
          Desktop {num(desktop.current)} ({share(desktop.current)}) · Mobile {num(mobile.current)} ({share(mobile.current)})
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {PREVIOUS[data.range].replace(/^./, (c) => c.toUpperCase())}: desktop {num(desktop.previous)}, mobile {num(mobile.previous)}
        </p>
      </Card>
    </div>
  );
}

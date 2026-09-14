import { Star } from "lucide-react";
import { AreaChart, BarChart } from "@/components/reports/charts";
import { PREVIOUS_LABEL, fmtBucket, fmtDelta, fmtHours, fmtPercent, fmtRating } from "./format";
import type { OverviewResponse } from "./types";

/**
 * The Overview's headline tiles, trend charts and star distribution. Pure
 * presentation of the API's numbers — every value here is computed and
 * unit-tested in lib/reputation/overview.ts.
 */

type Data = OverviewResponse;
type Reviews = NonNullable<Data["reviews"]>;

export function Card({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-5" data-testid={testId}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Tile({ testId, label, value, note, scope }: { testId: string; label: string; value: string; note: string; scope?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-4" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold" data-testid={`${testId}-value`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-note`}>{note}</p>
      {scope && <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`${testId}-scope`}>{scope}</p>}
    </div>
  );
}

export function Tiles({ data }: { data: Data }) {
  const r = data.reviews;
  const prev = PREVIOUS_LABEL[data.range.preset];
  const reqPrev = data.requests.previous;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {r && (
        <>
          <Tile
            testId="rep-tile-avg"
            label="Average rating"
            value={fmtRating(r.avgRating)}
            note={
              r.previous && r.avgRating !== null && r.previous.avgRating !== null
                ? `${fmtDelta(r.avgRating - r.previous.avgRating, 1)} vs ${prev}`
                : "No earlier period to compare"
            }
          />
          <Tile
            testId="rep-tile-count"
            label="Reviews in range"
            value={String(r.count)}
            note={r.previous ? `${fmtDelta(r.count - r.previous.count)} vs ${prev}` : "No earlier period to compare"}
          />
          <Tile testId="rep-tile-coverage" label="Response coverage" value={fmtPercent(r.response.coverage)} note={`${r.response.replied} of ${r.count} replied`} />
          <Tile
            testId="rep-tile-reply-time"
            label="Avg time to latest reply"
            value={fmtHours(r.response.replyHours.avg)}
            note={r.response.replyHours.median === null ? "No replies in range" : `Median ${fmtHours(r.response.replyHours.median)}`}
          />
        </>
      )}
      <Tile
        testId="rep-tile-requests"
        label="Requests sent"
        value={String(data.requests.sent)}
        note={reqPrev ? `${fmtDelta(data.requests.sent - reqPrev.sent)} vs ${prev}` : data.requests.countingSince ? "Since the first logged request" : "None logged yet"}
        scope="Request review, quote paid and deal completed only"
      />
    </div>
  );
}

export function Trend({ data }: { data: Data }) {
  const points = data.trend.map((b) => ({ x: fmtBucket(b.start, data.range.bucket), y: b.reviews ?? 0 }));
  // A bucket with no reviews has no average — it is left out, never drawn as 0.
  const rating = data.trend.flatMap((b) => (b.avgRating === null ? [] : [{ x: fmtBucket(b.start, data.range.bucket), y: b.avgRating }]));
  const per = data.range.bucket === "week" ? "week" : "month";
  return (
    <Card testId="rep-trend" title="Reviews and ratings trend">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Reviews per {per}</p>
          <BarChart data={points} tone="amber" />
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Average rating per {per}</p>
          {rating.length ? <AreaChart data={rating} tone="amber" /> : <p className="text-sm text-muted-foreground">No ratings in this range.</p>}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Periods start on {per === "week" ? "Mondays" : "the 1st"}, UTC.</p>
    </Card>
  );
}

export function Distribution({ reviews }: { reviews: Reviews }) {
  const total = reviews.count;
  return (
    <Card testId="rep-distribution" title="Star distribution">
      <ul className="space-y-2">
        {([5, 4, 3, 2, 1] as const).map((s) => {
          const n = reviews.distribution[s];
          const pct = total ? Math.round((n / total) * 100) : 0;
          return (
            <li key={s} className="flex items-center gap-3 text-sm" data-testid={`rep-distribution-${s}`} data-count={n}>
              <span className="flex w-10 items-center gap-1">
                {s} <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
              </span>
              <span className="w-16 text-right text-muted-foreground">{n} · {pct}%</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

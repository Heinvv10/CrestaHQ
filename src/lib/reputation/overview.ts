import { toMillis } from "@/lib/gbp/sync/types";

/**
 * The Reputation overview numbers (SP5 a) — pure, so every figure the page
 * shows is unit-tested here and the route only feeds it.
 *
 * Definitions (docs/features/reputation.md):
 *   - range: the last N days ending now (`30d`/`90d`/`365d`), compared with
 *     the N days before it; `all` starts at the oldest review or request and
 *     has no previous period. Both ends inclusive of `from`, up to `now`.
 *   - buckets: ISO weeks (Monday 00:00 UTC) for spans up to 90 days, calendar
 *     months (the 1st, 00:00 UTC) beyond. Contiguous, empty buckets included;
 *     the first bucket may start before `from` and counts only what is in range.
 *   - response coverage: replied ÷ reviews in range (null with no reviews).
 *   - time to latest reply: reply.updateTime − createTime, over replied
 *     reviews only. Google reports only the LATEST reply time, so an edited
 *     reply moves it. Missing or negative values are excluded and counted.
 *   - sentiment: current labels (SP5 b) over the reviews in range — the
 *     caller passes only a label derived from the review's current content;
 *     "couldn't be analysed" = the AI failed on it 3 times; any other review
 *     without a label is "not analysed yet".
 *   - requests are counted from the reviewRequests log, from the first logged
 *     request (`countingSince`); they are never linked to reviews.
 */

export const RANGE_PRESETS = ["30d", "90d", "365d", "all"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type Bucket = "week" | "month";

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const DAYS: Record<Exclude<RangePreset, "all">, number> = { "30d": 30, "90d": 90, "365d": 365 };
/** Spans up to this many days are bucketed by week, longer ones by month. */
const WEEKLY_UP_TO_DAYS = 90;

/** `null`/empty → the default; anything that is not a preset → null (the route's 400). */
export function parseRange(v: string | null): RangePreset | null {
  if (v === null || v === "") return "90d";
  return (RANGE_PRESETS as readonly string[]).includes(v) ? (v as RangePreset) : null;
}

/** Where the previous period starts — the earliest request a preset can count (null for `all`). */
export function previousPeriodStart(range: RangePreset, now: Date): Date | null {
  return range === "all" ? null : new Date(now.getTime() - 2 * DAYS[range] * DAY);
}

export interface OverviewReviewInput {
  starRating: unknown;
  createTime: unknown;
  reply: { updateTime?: unknown } | null | undefined;
  sentiment?: { label?: unknown } | null;
  /** The AI failed on this content MAX_SENTIMENT_FAILURES times (it will not be retried). */
  sentimentGaveUp?: boolean;
}
export interface OverviewRequestInput {
  channel: unknown;
  sentAt: unknown;
}

export interface TrendBucket {
  start: string;
  /** null when review data is unavailable (gate off / not connected / no listing). */
  reviews: number | null;
  avgRating: number | null;
  avgReplyHours: number | null;
  requests: number;
}

export interface Overview {
  range: { preset: RangePreset; bucket: Bucket; from: string; to: string; previousFrom: string | null };
  reviews: null | {
    count: number;
    avgRating: number | null;
    previous: { count: number; avgRating: number | null } | null;
    distribution: Record<1 | 2 | 3 | 4 | 5, number>;
    sentiment: { positive: number; neutral: number; negative: number; notAnalysed: number; failed: number };
    response: {
      replied: number;
      unreplied: number;
      coverage: number | null;
      replyHours: { avg: number | null; median: number | null; counted: number; excluded: number };
    };
  };
  requests: {
    sent: number;
    byChannel: Record<string, number>;
    previous: { sent: number } | null;
    countingSince: string | null;
  };
  trend: TrendBucket[];
}

interface Rev {
  at: number;
  stars: number | null;
  replied: boolean;
  /** Hours to the latest reply; null when not replied or not usable. */
  replyHours: number | null;
  sentiment: "positive" | "neutral" | "negative" | "failed" | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bucketStart(ms: number, bucket: Bucket): number {
  const d = new Date(ms);
  if (bucket === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY; // back to Monday
}

function nextBucket(ms: number, bucket: Bucket): number {
  if (bucket === "week") return ms + 7 * DAY;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function toRev(r: OverviewReviewInput): Rev | null {
  const at = toMillis(r.createTime);
  if (at === null) return null;
  const stars = typeof r.starRating === "number" && r.starRating >= 1 && r.starRating <= 5 ? r.starRating : null;
  const replied = !!r.reply;
  const replyAt = replied ? toMillis(r.reply?.updateTime) : null;
  const replyHours = replyAt !== null && replyAt >= at ? (replyAt - at) / HOUR : null;
  const label = r.sentiment?.label;
  const sentiment =
    label === "positive" || label === "neutral" || label === "negative" ? label : r.sentimentGaveUp ? "failed" : null;
  return { at, stars, replied, replyHours, sentiment };
}

const ratingsOf = (rs: Rev[]) => rs.flatMap((r) => (r.stars === null ? [] : [r.stars]));

export function computeOverview(input: {
  /** null = review data unavailable; the request half is still computed. */
  reviews: OverviewReviewInput[] | null;
  requests: OverviewRequestInput[];
  /** The oldest reviewRequests entry ever (not just in range). */
  oldestRequestAt: unknown;
  range: RangePreset;
  now: Date;
}): Overview {
  const now = input.now.getTime();
  const revs = input.reviews?.flatMap((r) => toRev(r) ?? []) ?? [];
  const reqs = input.requests.flatMap((r) => {
    const at = toMillis(r.sentAt);
    return at === null ? [] : [{ at, channel: typeof r.channel === "string" ? r.channel : "unknown" }];
  });
  const oldestRequest = toMillis(input.oldestRequestAt);

  let from: number;
  let previousFrom: number | null;
  if (input.range === "all") {
    const starts = [...revs.map((r) => r.at), ...(oldestRequest === null ? [] : [oldestRequest])].filter((t) => t <= now);
    from = starts.length ? Math.min(...starts) : now;
    previousFrom = null;
  } else {
    from = now - DAYS[input.range] * DAY;
    previousFrom = from - DAYS[input.range] * DAY;
  }
  const bucket: Bucket = now - from <= WEEKLY_UP_TO_DAYS * DAY ? "week" : "month";

  const inRange = (t: number) => t >= from && t <= now;
  const inPrevious = (t: number) => previousFrom !== null && t >= previousFrom && t < from;

  const current = revs.filter((r) => inRange(r.at));
  const before = revs.filter((r) => inPrevious(r.at));
  const replyTimes = current.filter((r) => r.replied && r.replyHours !== null).map((r) => r.replyHours as number);
  const replied = current.filter((r) => r.replied).length;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  for (const s of ratingsOf(current)) distribution[s as 1 | 2 | 3 | 4 | 5]++;
  const sentiment = { positive: 0, neutral: 0, negative: 0, notAnalysed: 0, failed: 0 };
  for (const r of current) sentiment[r.sentiment ?? "notAnalysed"]++;

  const reqsInRange = reqs.filter((r) => inRange(r.at));
  const byChannel: Record<string, number> = {};
  for (const r of reqsInRange) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
  // A previous count only when the first logged send is at or before previousFrom.
  const logCoversPrevious = previousFrom !== null && oldestRequest !== null && oldestRequest <= previousFrom;

  const trend: TrendBucket[] = [];
  for (let start = bucketStart(from, bucket); start <= now; start = nextBucket(start, bucket)) {
    const end = nextBucket(start, bucket);
    const inBucket = (t: number) => inRange(t) && t >= start && t < end;
    const rs = current.filter((r) => inBucket(r.at));
    const replies = rs.flatMap((r) => (r.replied && r.replyHours !== null ? [r.replyHours] : []));
    trend.push({
      start: new Date(start).toISOString(),
      reviews: input.reviews ? rs.length : null,
      avgRating: input.reviews ? mean(ratingsOf(rs)) : null,
      avgReplyHours: input.reviews ? mean(replies) : null,
      requests: reqsInRange.filter((r) => inBucket(r.at)).length,
    });
  }

  return {
    range: {
      preset: input.range,
      bucket,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      previousFrom: previousFrom === null ? null : new Date(previousFrom).toISOString(),
    },
    reviews: input.reviews
      ? {
          count: current.length,
          avgRating: mean(ratingsOf(current)),
          previous: before.length ? { count: before.length, avgRating: mean(ratingsOf(before)) } : null,
          distribution,
          sentiment,
          response: {
            replied,
            unreplied: current.length - replied,
            coverage: current.length ? replied / current.length : null,
            replyHours: {
              avg: mean(replyTimes),
              median: median(replyTimes),
              counted: replyTimes.length,
              excluded: replied - replyTimes.length,
            },
          },
        }
      : null,
    requests: {
      sent: reqsInRange.length,
      byChannel,
      previous: logCoversPrevious ? { sent: reqs.filter((r) => inPrevious(r.at)).length } : null,
      countingSince: oldestRequest === null ? null : new Date(oldestRequest).toISOString(),
    },
    trend,
  };
}

import "server-only";

import {
  GbpProviderError,
  type GbpAccount,
  type GbpDailyMetric,
  type GbpDailySeries,
  type GbpLocation,
  type GbpReview,
  type GbpReviewReply,
  type GbpReviewsPage,
  type GbpPage,
} from "./types";

/**
 * Google payload → domain types. Fail CLOSED: a field we depend on that is
 * missing or the wrong type throws `malformed` rather than being guessed at.
 * Optional display fields degrade to null. Text is never trimmed.
 */

type Obj = Record<string, unknown>;

const bad = () => new GbpProviderError("malformed");

function obj(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  return v as Obj;
}

function str(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw bad();
  return v;
}

function optStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw bad();
  return v;
}

function optNum(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad();
  return v;
}

function list(v: unknown): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad();
  return v;
}

function nextToken(v: unknown): string | null {
  const t = optStr(v);
  return t ? t : null;
}

export function parseAccounts(body: unknown): GbpPage<GbpAccount> {
  const b = obj(body);
  return {
    items: list(b.accounts).map((raw) => {
      const a = obj(raw);
      const name = str(a.name);
      return {
        name,
        accountName: optStr(a.accountName) ?? name,
        type: optStr(a.type) ?? "UNKNOWN",
      };
    }),
    nextPageToken: nextToken(b.nextPageToken),
  };
}

function formatAddress(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const a = obj(raw);
  const lines = list(a.addressLines).map((l) => optStr(l) ?? "");
  return [...lines, optStr(a.locality) ?? "", optStr(a.postalCode) ?? ""]
    .filter((p) => p.length > 0)
    .join(", ");
}

export function parseLocations(body: unknown): GbpPage<GbpLocation> {
  const b = obj(body);
  return {
    items: list(b.locations).map((raw) => {
      const l = obj(raw);
      const meta = l.metadata === undefined ? {} : obj(l.metadata);
      return {
        name: str(l.name),
        title: str(l.title),
        address: formatAddress(l.storefrontAddress),
        websiteUri: optStr(l.websiteUri),
        placeId: optStr(meta.placeId),
        mapsUri: optStr(meta.mapsUri),
        newReviewUri: optStr(meta.newReviewUri),
      };
    }),
    nextPageToken: nextToken(b.nextPageToken),
  };
}

const STARS: Record<string, GbpReview["starRating"]> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function parseReply(raw: unknown): GbpReviewReply {
  const r = obj(raw);
  // A reply's comment is a string (possibly empty) — keep it byte-exact.
  if (typeof r.comment !== "string") throw bad();
  return { comment: r.comment, updateTime: str(r.updateTime) };
}

function parseReview(raw: unknown): GbpReview {
  const r = obj(raw);
  const reviewer = r.reviewer === undefined ? {} : obj(r.reviewer);
  const isAnonymous = reviewer.isAnonymous === true;
  // STAR_RATING_UNSPECIFIED or anything unknown fails closed: a review we
  // cannot rate truthfully must not be stored with a guessed rating.
  const star = typeof r.starRating === "string" ? STARS[r.starRating] : undefined;
  if (!star) throw bad();
  return {
    name: str(r.name),
    reviewId: str(r.reviewId),
    reviewer: {
      displayName: optStr(reviewer.displayName) ?? "",
      profilePhotoUrl: optStr(reviewer.profilePhotoUrl),
      isAnonymous,
    },
    starRating: star,
    comment: optStr(r.comment),
    createTime: str(r.createTime),
    updateTime: str(r.updateTime),
    reply: r.reviewReply === undefined || r.reviewReply === null ? null : parseReply(r.reviewReply),
  };
}

export function parseReviews(body: unknown): GbpReviewsPage {
  const b = obj(body);
  return {
    reviews: list(b.reviews).map(parseReview),
    averageRating: optNum(b.averageRating),
    totalReviewCount: optNum(b.totalReviewCount),
    nextPageToken: nextToken(b.nextPageToken),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function dayOf(raw: unknown): string {
  const d = obj(raw);
  const [y, m, day] = [d.year, d.month, d.day];
  if (![y, m, day].every((n) => Number.isInteger(n) && (n as number) > 0)) throw bad();
  return `${y}-${pad(m as number)}-${pad(day as number)}`;
}

/**
 * fetchMultiDailyMetricsTimeSeries → one series per REQUESTED metric (others
 * ignored). `value` is an int64 string that Google leaves out when it is 0.
 */
export function parseDailyMetrics(body: unknown, metrics: GbpDailyMetric[]): GbpDailySeries {
  const out: GbpDailySeries = Object.fromEntries(metrics.map((m) => [m, []]));
  for (const group of list(obj(body).multiDailyMetricTimeSeries)) {
    for (const raw of list(obj(group).dailyMetricTimeSeries)) {
      const series = obj(raw);
      const metric = series.dailyMetric as GbpDailyMetric;
      if (!metrics.includes(metric)) continue;
      const values = list(obj(series.timeSeries ?? {}).datedValues).map((dv) => {
        const v = obj(dv);
        if (v.value !== undefined && (typeof v.value !== "string" || !/^\d+$/.test(v.value))) throw bad();
        return { date: dayOf(v.date), value: v.value === undefined ? 0 : Number(v.value) };
      });
      out[metric] = [...(out[metric] ?? []), ...values];
    }
  }
  return out;
}

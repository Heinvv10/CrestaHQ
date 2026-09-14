import type { GoogleTokens } from "@/lib/google/oauth";

/**
 * The Google Business Profile provider boundary. Every Google HTTP call the
 * product makes goes through an implementation of {@link GbpProvider} — the
 * real one (`google.ts`) or the deterministic fake (`fake.ts`). Callers obtain
 * one ONLY via `getGbpProviderFor(subAccountId)` in `select.ts`.
 *
 * Identifier model (these are three different things; never conflate them):
 *   - GBP account        `accounts/{a}`                  Account Management API
 *   - GBP location       `locations/{l}`                 Business Information API
 *   - v4 review parent   `accounts/{a}/locations/{l}`    legacy v4 reviews API
 *   - Place ID / Maps URI — display + link metadata only, never a resource key.
 */

export interface GbpAccount {
  /** `accounts/{a}` */
  name: string;
  accountName: string;
  type: string;
}

export interface GbpLocation {
  /** `locations/{l}` — the Business Information resource name. */
  name: string;
  title: string;
  /** One formatted line: address lines, locality, postal code. "" when none. */
  address: string;
  websiteUri: string | null;
  /** Display/link only. NOT a GBP resource key. */
  placeId: string | null;
  mapsUri: string | null;
  newReviewUri: string | null;
}

export interface GbpReviewReply {
  comment: string;
  updateTime: string;
}

export interface GbpReview {
  /** `accounts/{a}/locations/{l}/reviews/{r}` */
  name: string;
  reviewId: string;
  reviewer: {
    displayName: string;
    profilePhotoUrl: string | null;
    isAnonymous: boolean;
  };
  starRating: 1 | 2 | 3 | 4 | 5;
  /**
   * BYTE-EXACT as Google returned it. Never trimmed or normalised — Google's
   * "(Translated by Google) … (Original) …" block must survive untouched.
   */
  comment: string | null;
  createTime: string;
  updateTime: string;
  reply: GbpReviewReply | null;
}

export interface GbpReviewsPage {
  reviews: GbpReview[];
  /** Absent from Google's response → null. Never invented. */
  averageRating: number | null;
  totalReviewCount: number | null;
  nextPageToken: string | null;
}

/**
 * The Business Profile Performance API daily metrics the Insights tab reads
 * (SP5 G2). Impressions are unique users per day, per Google.
 */
export const GBP_DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_BOOKINGS",
] as const;
export type GbpDailyMetric = (typeof GBP_DAILY_METRICS)[number];

/** One day of one metric. `date` is `YYYY-MM-DD` as Google dates it; `value` ≥ 0 (Google omits zeros). */
export interface GbpDatedValue {
  date: string;
  value: number;
}

/** Every requested metric has a series (possibly empty); days Google left out are not invented here. */
export type GbpDailySeries = Partial<Record<GbpDailyMetric, GbpDatedValue[]>>;

export interface GbpPage<T> {
  items: T[];
  nextPageToken: string | null;
}

export interface GbpProvider {
  // OAuth -------------------------------------------------------------------
  /** The consent URL (the fake skips the Google hop and targets the callback). */
  authorizeUrl(opts: { redirectUri: string; state: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens>;
  /** `refreshToken` on the result is non-null only when Google rotated it. */
  refresh(refreshToken: string): Promise<GoogleTokens>;
  revoke(token: string): Promise<void>;

  // Data --------------------------------------------------------------------
  listAccounts(accessToken: string, pageToken?: string): Promise<GbpPage<GbpAccount>>;
  listLocations(
    accessToken: string,
    accountName: string,
    pageToken?: string,
  ): Promise<GbpPage<GbpLocation>>;
  listReviews(
    accessToken: string,
    ref: { accountName: string; locationName: string },
    pageToken?: string,
  ): Promise<GbpReviewsPage>;
  putReply(accessToken: string, reviewName: string, comment: string): Promise<GbpReviewReply>;
  deleteReply(accessToken: string, reviewName: string): Promise<void>;
  /** Performance API daily series for one location, `startDate`..`endDate` inclusive (`YYYY-MM-DD`). */
  fetchDailyMetrics(
    accessToken: string,
    locationName: string,
    opts: { metrics: GbpDailyMetric[]; startDate: string; endDate: string },
  ): Promise<GbpDailySeries>;
}

export type GbpProviderErrorKind =
  | "auth_expired"
  | "revoked"
  | "insufficient_scope"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  /** A 429 whose quota is 0: Google has not approved API access for the project. Not transient. */
  | "access_not_approved"
  | "transient"
  | "malformed";

/**
 * Typed provider failure. The message is FIXED per kind + status: it never
 * carries a response body, a URL query or a token, so it is safe to log and
 * safe to surface as a `code` to the browser.
 */
export class GbpProviderError extends Error {
  readonly kind: GbpProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: GbpProviderErrorKind,
    opts: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(
      `Google Business Profile provider error: ${kind}` +
        (opts.status !== undefined ? ` (HTTP ${opts.status})` : ""),
    );
    this.name = "GbpProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Resource-name shapes. Anchored so an id can never smuggle a path segment. */
export const ACCOUNT_NAME_RE = /^accounts\/[A-Za-z0-9_-]+$/;
export const LOCATION_NAME_RE = /^locations\/[A-Za-z0-9_-]+$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const REVIEW_NAME_RE =
  /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/reviews\/[A-Za-z0-9_-]+$/;

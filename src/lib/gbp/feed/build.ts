import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { deriveHealth } from "@/lib/gbp/sync/health";
import { withinRetention } from "@/lib/gbp/sync/reconcile";
import { reviewsCollection, toMillis, type GbpSummary } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";
import { FEED_SOURCE, feedListing, feedReview, type FeedBody, type FeedStatus } from "./serialize";
import { PUBLIC_ID_RE, widgetPath, type GbpWidgetDoc } from "./widget-store";

/**
 * Resolving a public widget id and building its feed body.
 *
 * Freshness (docs/features/gbp-reviews.md › Public feed):
 *   - `ok`          the last success is recent and PR 2's `deriveHealth` says ok;
 *   - `stale`       served, labelled: health is anything but ok — the last
 *                   success is over 12h old, the grant needs a reconnect, the
 *                   last run was partial or failed (a Google outage);
 *   - `unavailable` reviews `[]`, rating null: no listing, never synced, the
 *                   summary is another listing's, or the last success is over
 *                   7 days old (which also covers Google's 30-day retention).
 * Each review must also pass the sync's own read-time 30-day predicate
 * (`withinRetention`). Nothing is ever presented as live.
 */

export const FEED_UNAVAILABLE_AFTER_MS = 7 * 24 * 3600_000;
/**
 * The newest records scanned per request (createTime desc, one single-field
 * query — no composite index). Tombstones and expired reviews among them are
 * skipped, so in a pathological cache the feed may hold fewer than
 * maxReviews — never an invented one.
 */
const SCAN_CAP = 200;

type Sub = SubAccountDoc & { gbpSummary?: GbpSummary | null };
export interface FeedTarget {
  widget: GbpWidgetDoc;
  sub: Sub;
}

/** Null (→ the one 404) for a malformed, unknown or disabled id, or the agency gate off. */
export async function resolveFeedTarget(publicId: string): Promise<FeedTarget | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const db = getAdminDb();
  const widget = (await db.doc(widgetPath(publicId)).get()).data() as GbpWidgetDoc | undefined;
  if (!widget || widget.enabled !== true) return null;
  const sub = (await db.doc(`subAccounts/${widget.subAccountId}`).get()).data() as Sub | undefined;
  // The same rule as googleGateOn (opt-in: unset reads as off) on the doc we already hold.
  if (sub?.googleEnabledByAgency !== true) return null;
  return { widget, sub };
}

export async function buildFeed({ widget, sub }: FeedTarget, now: Date): Promise<FeedBody> {
  const listing = sub.googleListing ?? null;
  const summary = listing && sub.gbpSummary?.locationName === listing.locationName ? sub.gbpSummary : null;
  const last = toMillis(summary?.lastSuccessfulSyncAt);
  const health = deriveHealth(summary, now, { reconnectRequired: sub.googleConnectionMeta?.reconnectRequired });
  const unavailable = !listing || last === null || now.getTime() - last > FEED_UNAVAILABLE_AFTER_MS;
  const status: FeedStatus = unavailable ? "unavailable" : health === "ok" ? "ok" : "stale";

  let reviews: FeedBody["reviews"] = [];
  let rating: FeedBody["rating"] = null;
  if (!unavailable) {
    const snap = await getAdminDb()
      .collection(reviewsCollection(widget.subAccountId))
      .orderBy("createTime", "desc")
      .limit(SCAN_CAP)
      .get();
    reviews = snap.docs
      .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
      .filter(({ data }) => data.state === "active" && data.locationName === listing.locationName && withinRetention(data.lastSeenAt, now))
      .map(({ id, data }) => ({ id, data, at: toMillis(data.createTime) ?? 0 }))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, widget.maxReviews)
      .map(({ id, data }) => feedReview(id, data));
    const { averageRating, totalReviewCount } = summary ?? {};
    if (typeof averageRating === "number" && typeof totalReviewCount === "number") {
      rating = { average: averageRating, count: totalReviewCount };
    }
  }

  return {
    version: 1,
    status,
    listing: feedListing(listing as unknown as Record<string, unknown> | null),
    rating,
    source: { ...FEED_SOURCE },
    freshness: {
      lastSuccessfulSyncAt: last === null ? null : new Date(last).toISOString(),
      stale: status !== "ok",
      generatedAt: now.toISOString(),
    },
    reviews,
  };
}

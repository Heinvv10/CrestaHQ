import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withinRetention } from "./reconcile";
import { reviewsCollection, toMillis } from "./types";

/** Records read per listing per request — `truncated` says when there really is a 501st. */
export const SERVED_REVIEW_CAP = 500;

/**
 * The reviews a member may be shown: active reviews of the given listings
 * (the callers' CURRENT ones), re-seen within Google's 30-day limit, newest
 * first. Per listing, from its newest 500 records (tombstones included in
 * that count — filtering them in the query would need another index), so a
 * busy listing can never crowd a quiet one out; `truncated` when any listing
 * really has a 501st. One definition for the reviews inbox and the Reputation
 * overview, so the two can never count different sets. One query per listing
 * on the composite index `gbpReviews: locationName ASC, createTime DESC`.
 */
export async function loadServedReviews(
  subAccountId: string,
  locationNames: string[],
  now: Date,
): Promise<{ reviews: Array<Record<string, unknown>>; truncated: boolean }> {
  const reviews = getAdminDb().collection(reviewsCollection(subAccountId));
  const snaps = await Promise.all(
    locationNames.map((loc) =>
      reviews.where("locationName", "==", loc).orderBy("createTime", "desc").limit(SERVED_REVIEW_CAP + 1).get(),
    ),
  );
  const served = snaps
    .flatMap((snap) => snap.docs.slice(0, SERVED_REVIEW_CAP))
    .map((d): Record<string, unknown> => ({ ...d.data(), docId: d.id }))
    .filter((d) => d.state === "active" && withinRetention(d.lastSeenAt, now))
    .sort((a, b) => (toMillis(b.createTime) ?? 0) - (toMillis(a.createTime) ?? 0));
  return { reviews: served, truncated: snaps.some((snap) => snap.size > SERVED_REVIEW_CAP) };
}

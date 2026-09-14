import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withinRetention } from "./reconcile";
import { reviewsCollection } from "./types";

/** Records read per request — `truncated` says when there really is a 501st. */
export const SERVED_REVIEW_CAP = 500;

/**
 * The reviews a member may be shown: active reviews of the CURRENT listing,
 * re-seen within Google's 30-day limit, newest first, from the newest 500
 * records (tombstones included in that count — filtering them in the query
 * would need a composite index). One definition for the reviews inbox and
 * the Reputation overview, so the two can never count different sets.
 * Single-field query only.
 */
export async function loadServedReviews(
  subAccountId: string,
  locationName: string | null,
  now: Date,
): Promise<{ reviews: Array<Record<string, unknown>>; truncated: boolean }> {
  const snap = await getAdminDb()
    .collection(reviewsCollection(subAccountId))
    .orderBy("createTime", "desc")
    .limit(SERVED_REVIEW_CAP + 1)
    .get();
  const reviews = locationName
    ? snap.docs
        .slice(0, SERVED_REVIEW_CAP)
        .map((d): Record<string, unknown> => ({ ...d.data(), docId: d.id }))
        .filter((d) => d.state === "active" && d.locationName === locationName && withinRetention(d.lastSeenAt, now))
    : [];
  return { reviews, truncated: snap.size > SERVED_REVIEW_CAP };
}

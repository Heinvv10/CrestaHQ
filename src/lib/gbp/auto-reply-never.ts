import { createHash } from "node:crypto";

/**
 * `subAccounts/{sa}/autoReplyNever/{stableReviewKey}` — the durable "never
 * auto-reply to this review" marker (AUTO_REPLY_V1_PLAN.md rev 5). Written
 * wherever a review is first known to have a reply (the sync, a posted reply,
 * a finalized auto post) and never deleted: it lives OUTSIDE the review cache,
 * so a cache clear (Google gate toggle, listing change) cannot make the engine
 * forget a reply someone deleted or a reply it already posted. An id, a
 * reason and the cache doc id it was written for — no Google content — so it
 * deliberately outlives review retention. Server-only (no client rule).
 */

export type NeverReason = "replied" | "auto_replied";

/**
 * An ACCOUNT-INDEPENDENT review key: sha256 of `locations/{loc}/reviews/{id}`
 * (the `accounts/{a}/` prefix stripped). The same location reached through
 * another Google account names its reviews under that account, so the cache
 * doc id (sha256 of the full name) changes; this key does not. Markers and
 * Discards (`autoReplyDismissed`) are keyed by it.
 */
export function stableReviewKey(reviewName: string): string {
  const local = reviewName.replace(/^accounts\/[^/]+\//, "");
  return createHash("sha256").update(local).digest("hex").slice(0, 40);
}

export const autoReplyNeverCollection = (sa: string) => `subAccounts/${sa}/autoReplyNever`;
export const autoReplyNeverPath = (sa: string, reviewName: string) =>
  `${autoReplyNeverCollection(sa)}/${stableReviewKey(reviewName)}`;

export function neverMarker(
  t: { agencyId: string; subAccountId: string; createdByUid: string | null },
  reason: NeverReason,
  at: Date,
  reviewDocId: string,
): Record<string, unknown> {
  return { agencyId: t.agencyId, subAccountId: t.subAccountId, createdByUid: t.createdByUid, reason, at, reviewDocId };
}

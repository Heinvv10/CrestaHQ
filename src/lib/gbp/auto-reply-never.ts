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

/**
 * `star` (auto_replied only): the rating when auto-reply answered it — so an
 * edit down to ≤3★ is still recognised after a cache clear (PR 4 alerts).
 */
export function neverMarker(
  t: { agencyId: string; subAccountId: string; createdByUid: string | null },
  reason: NeverReason,
  at: Date,
  reviewDocId: string,
  star: number | null = null,
): Record<string, unknown> {
  return {
    agencyId: t.agencyId, subAccountId: t.subAccountId, createdByUid: t.createdByUid, reason, at, reviewDocId,
    ...(reason === "auto_replied" ? { star } : {}),
  };
}

export interface NeverMarkerSeen {
  /**
   * The marker's reply is an auto-reply: reason `auto_replied`, or a `star`
   * field — only auto-reply writes one, and it survives a sync's merge that
   * rewrote the reason (a sync overlapping the post); a human reply's
   * marker is a full set() and drops it.
   */
  autoReplied: boolean;
  /** The star when auto-replied; null when not recorded. */
  star: number | null;
}

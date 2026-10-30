import { publicApproval, type PublicApproval } from "@/lib/reputation/auto-reply/approval";
import { currentSentiment } from "@/lib/reputation/sentiment-basis";
import { deriveHealth } from "./health";
import { retentionBasis } from "./reconcile";
import { RETENTION_MS, toMillis, type GbpHealth, type GbpSummary, type SyncRunRecord } from "./types";

/**
 * What a signed-in member's browser may see of the sync. Explicit field
 * lists — never a spread of a stored doc — so passId, contentHash, reviewName
 * (it carries the GBP account id), private state and anything added to the
 * docs later cannot leak by accident.
 */

const iso = (v: unknown): string | null => {
  const ms = toMillis(v);
  return ms === null ? null : new Date(ms).toISOString();
};

export interface PublicRun {
  trigger: string;
  /** The listing this run was for (a sub-account may have several). */
  locationName: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  pagesFetched: number;
  reviewsSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  purged: number;
  reconciliation: string;
  resumedFromCursor: boolean;
  errorKind: string | null;
  skipReason: string | null;
}

export function publicRun(r: Partial<SyncRunRecord>): PublicRun {
  return {
    trigger: String(r.trigger ?? ""),
    locationName: r.locationName ?? null,
    status: String(r.status ?? ""),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    pagesFetched: r.pagesFetched ?? 0,
    reviewsSeen: r.reviewsSeen ?? 0,
    created: r.created ?? 0,
    updated: r.updated ?? 0,
    unchanged: r.unchanged ?? 0,
    removed: r.removed ?? 0,
    purged: r.purged ?? 0,
    reconciliation: String(r.reconciliation ?? ""),
    resumedFromCursor: r.resumedFromCursor === true,
    errorKind: r.errorKind ?? null,
    skipReason: r.skipReason ?? null,
  };
}

export interface PublicReview {
  reviewId: string;
  /** The cache doc id — how the reply route addresses a review (the public feed already serves it as `id`). */
  docId: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean } | null;
  starRating: number;
  /** Byte-exact, never truncated. */
  comment: string | null;
  createTime: string | null;
  updateTime: string | null;
  reply: { comment: string; updateTime: string } | null;
  /** SP5 (b): the current label and how it was reached — never its basis, model or time; null when stale. */
  sentiment: { label: string; method: string } | null;
  /** The reply was posted by review auto-reply. */
  autoReplied: boolean;
  /** A fresh auto-reply draft waiting for a person — its reason and text only. */
  approval: PublicApproval | null;
  /** The listing the review is on (a sub-account may have several); null when the caller did not say. */
  listing: PublicListing | null;
}

export interface PublicListing {
  locationName: string;
  title: string;
}

/**
 * `autoPosts(star)`: whether auto-reply would post that star of THIS review
 * right now (a queued draft reads as paused otherwise). `listing`: the
 * review's listing, looked up by the caller from its `locationName`.
 */
export function publicReview(
  d: Record<string, unknown>,
  autoPosts: (star: number) => boolean = () => false,
  listing: PublicListing | null = null,
): PublicReview {
  const reviewer = d.reviewer as PublicReview["reviewer"];
  const reply = d.reply as PublicReview["reply"];
  return {
    reviewId: String(d.reviewId ?? ""),
    docId: String(d.docId ?? ""),
    reviewer: reviewer
      ? { displayName: reviewer.displayName, profilePhotoUrl: reviewer.profilePhotoUrl, isAnonymous: reviewer.isAnonymous }
      : null,
    starRating: Number(d.starRating ?? 0),
    comment: typeof d.comment === "string" ? d.comment : null,
    createTime: iso(d.createTime),
    updateTime: iso(d.updateTime),
    reply: reply ? { comment: reply.comment, updateTime: reply.updateTime } : null,
    // Only a label derived from the review's CURRENT content — a sync edit keeps the old one on the doc.
    sentiment: currentSentiment(d),
    autoReplied: !!d.autoReplied,
    approval: publicApproval(d, autoPosts),
    listing: listing ? { locationName: listing.locationName, title: listing.title } : null,
  };
}

export interface PublicSummary {
  averageRating: number | null;
  totalReviewCount: number | null;
  lastSuccessfulSyncAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string;
  lastErrorKind: string | null;
  lastReconciliation: string | null;
  /** Re-derived against the request's clock and the live connection — never the stored value. */
  health: GbpHealth;
}

/**
 * `live` is the sub-account's current connection meta. Rating and count are
 * Google content too: past 30 days without a success they are not served,
 * whether or not a run has purged them yet.
 */
export function publicSummary(
  s: GbpSummary | null,
  now: Date,
  live: { reconnectRequired?: boolean | null },
): PublicSummary {
  const basis = retentionBasis(s, null);
  const expired = basis !== null && now.getTime() - basis > RETENTION_MS;
  return {
    averageRating: expired ? null : (s?.averageRating ?? null),
    totalReviewCount: expired ? null : (s?.totalReviewCount ?? null),
    lastSuccessfulSyncAt: iso(s?.lastSuccessfulSyncAt),
    lastRunAt: iso(s?.lastRunAt),
    lastRunStatus: s?.lastRunStatus ?? "never",
    lastErrorKind: s?.lastErrorKind ?? null,
    lastReconciliation: s?.lastReconciliation ?? null,
    health: deriveHealth(s, now, live),
  };
}

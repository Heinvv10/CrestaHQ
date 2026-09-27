import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { autoReplyNeverCollection, type NeverMarkerSeen } from "../auto-reply-never";
import type { GbpReview } from "../provider/types";
import { ownsDoc, type ListingScope } from "./scope";
import { reviewsCollection, toMillis, type GbpReviewDoc } from "./types";

/**
 * The review cache: deterministic doc ids (so an upsert is idempotent by
 * construction) and a content hash (so an unchanged review is never
 * rewritten). Clearing it lives in clear.ts.
 */

/** sha256(review.name) — the provider identity, never the Place ID. */
export function reviewDocId(reviewName: string): string {
  return createHash("sha256").update(reviewName).digest("hex").slice(0, 40);
}

/**
 * Over the provider fields a change to which must reach the cache. The review
 * `updateTime` is hashed as an instant, so Google's RFC 3339 string and the
 * same time read back from the stored doc (the explicit reply recomputes the
 * hash from it) hash alike.
 */
export function contentHash(r: {
  starRating: number | null;
  comment: string | null;
  updateTime: string;
  reply: GbpReview["reply"];
}): string {
  const reply = r.reply ? [r.reply.comment, r.reply.updateTime] : null;
  const ms = Date.parse(r.updateTime);
  const updateTime = Number.isNaN(ms) ? r.updateTime : new Date(ms).toISOString();
  return createHash("sha256")
    .update(JSON.stringify([r.starRating, r.comment, updateTime, reply]))
    .digest("hex");
}

/** What the sync needs to know about each cached doc — no content. */
export interface CachedReview {
  state: "active" | "removed";
  passId: string;
  lastSeenAt: number | null;
  contentHash: string | null;
  /** Stored misses; read only for reviews a pass did NOT see (absent = 0). */
  missedPasses?: number;
  /** The cached doc holds a reply, or was marked `hadReply` (auto-reply never replaces one). */
  replied?: boolean;
  /** Already marked `hadReply` (so its autoReplyNever marker is written). */
  hadReply?: boolean;
  /** The cached star rating of a review the engine auto-replied to; else null. */
  autoRepliedStar?: number | null;
}

/**
 * ONE listing's cache (see scope.ts): the read is the whole collection, as
 * before, filtered in memory by each doc's `locationName`, so reconciliation
 * and retention only ever see — and act on — that listing's reviews.
 */
export async function loadCache(subAccountId: string, scope: ListingScope): Promise<Map<string, CachedReview>> {
  const snap = await getAdminDb().collection(reviewsCollection(subAccountId)).get();
  const out = new Map<string, CachedReview>();
  for (const doc of snap.docs) {
    const d = doc.data() as Partial<GbpReviewDoc>;
    if (!ownsDoc(scope, d.locationName)) continue;
    out.set(doc.id, {
      state: d.state === "removed" ? "removed" : "active",
      passId: d.passId ?? "",
      lastSeenAt: toMillis(d.lastSeenAt),
      contentHash: d.contentHash ?? null,
      missedPasses: typeof d.missedPasses === "number" ? d.missedPasses : 0,
      replied: !!d.reply || d.hadReply === true,
      hadReply: d.hadReply === true,
      autoRepliedStar: (d as { autoReplied?: unknown }).autoReplied && typeof d.starRating === "number" ? d.starRating : null,
    });
  }
  return out;
}

/** The sub-account's `autoReplyNever` markers by stableReviewKey — durable, outside the cache. */
export async function loadNeverMarkers(subAccountId: string): Promise<Map<string, NeverMarkerSeen>> {
  const snap = await getAdminDb().collection(autoReplyNeverCollection(subAccountId)).get();
  const out = new Map<string, NeverMarkerSeen>();
  for (const doc of snap.docs) {
    const d = doc.data();
    out.set(doc.id, {
      autoReplied: d.reason === "auto_replied" || "star" in d,
      star: typeof d.star === "number" ? d.star : null,
    });
  }
  return out;
}

export interface UpsertContext {
  agencyId: string;
  subAccountId: string;
  createdByUid: string | null;
  locationName: string;
  passId: string;
  now: Date;
}

export type UpsertKind = "created" | "updated" | "unchanged";

/**
 * The write for one fetched review: a full doc when new (or coming back from
 * a tombstone), the content fields when the hash moved, otherwise only the
 * pass bookkeeping reconciliation needs.
 */
export function upsertFor(
  review: GbpReview,
  cached: CachedReview | undefined,
  ctx: UpsertContext,
  /** This review's durable autoReplyNever marker, if any. */
  marker?: NeverMarkerSeen,
): { kind: UpsertKind; data: Record<string, unknown>; merge: boolean; markNever: boolean; editedLow: boolean } {
  const hash = contentHash(review);
  // Seeing a review resets its miss count. A review seen WITH a reply — now,
  // or in the cached copy (a reply deleted since) — is marked `hadReply` for
  // good, and `markNever` asks the caller to write its autoReplyNever marker
  // (outside the cache) the first time: review auto-reply never replaces a
  // reply someone removed.
  const replied = !!review.reply || cached?.replied === true;
  // A marker already there is never rewritten (an `auto_replied` one must stay so).
  const markNever = replied && cached?.hadReply !== true && !marker;
  const seen = { lastSeenAt: ctx.now, passId: ctx.passId, missedPasses: 0, ...(replied ? { hadReply: true } : {}) };
  // A tombstone's contentHash is null, so a review that comes back is an update.
  if (cached && cached.contentHash === hash) {
    return { kind: "unchanged", data: seen, merge: true, markNever, editedLow: false };
  }
  // An auto-replied review now at ≤3★ after an edit — its star went down, or it
  // gained text (auto-reply only ever answers rating-only reviews): the caller
  // sends one alert. Known from the cache, or after a cache clear from the
  // durable marker.
  const autoReplied = cached?.autoRepliedStar != null || marker?.autoReplied === true;
  const was = cached?.autoRepliedStar ?? marker?.star ?? null;
  const editedLow = autoReplied && review.starRating <= 3
    && ((was !== null && review.starRating < was) || (review.comment ?? "").trim() !== "");
  const content = {
    // A reply from anywhere makes the auto-reply engine's draft moot.
    ...(review.reply ? { pendingReply: null } : {}),
    reviewer: review.reviewer,
    starRating: review.starRating,
    // Byte-exact: never trimmed, never normalised.
    comment: review.comment,
    updateTime: new Date(review.updateTime),
    reply: review.reply,
    state: "active",
    removedAt: null,
    contentHash: hash,
    ...seen,
  };
  if (cached) return { kind: "updated", data: content, merge: true, markNever, editedLow };
  const doc: GbpReviewDoc = {
    agencyId: ctx.agencyId,
    subAccountId: ctx.subAccountId,
    createdByUid: ctx.createdByUid,
    locationName: ctx.locationName,
    reviewName: review.name,
    reviewId: review.reviewId,
    reviewer: review.reviewer,
    starRating: review.starRating,
    comment: review.comment,
    createTime: new Date(review.createTime),
    updateTime: new Date(review.updateTime),
    reply: review.reply,
    state: "active",
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    removedAt: null,
    passId: ctx.passId,
    contentHash: hash,
    missedPasses: 0,
    ...(replied ? { hadReply: true } : {}),
  };
  return { kind: "created", data: doc as unknown as Record<string, unknown>, merge: false, markNever, editedLow };
}

/**
 * A removed review keeps only its ids and when it went — no content, no
 * rating. Its `sentiment` / `sentimentAttempt` (a 3-value label and hashes,
 * no content) are kept, so a review restored unchanged is not re-sent to the
 * AI and its strike count survives; retention deletion removes them with the doc.
 * An auto-reply draft (`pendingReply`, which may quote the reviewer's name) goes.
 */
export function tombstone(now: Date): Record<string, unknown> {
  return {
    state: "removed", removedAt: now, comment: null, reviewer: null, reply: null, starRating: null, contentHash: null,
    pendingReply: null,
  };
}

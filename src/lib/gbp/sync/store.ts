import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import type { GbpReview } from "../provider/types";
import {
  LEASE_TTL_MS,
  reviewsCollection,
  syncStatePath,
  toMillis,
  type GbpReviewDoc,
} from "./types";

/**
 * The review cache: deterministic doc ids (so an upsert is idempotent by
 * construction), a content hash (so an unchanged review is never rewritten),
 * and the one helper that throws the whole cache away.
 */

/** sha256(review.name) — the provider identity, never the Place ID. */
export function reviewDocId(reviewName: string): string {
  return createHash("sha256").update(reviewName).digest("hex").slice(0, 40);
}

/** Over the provider fields a change to which must reach the cache. */
export function contentHash(r: GbpReview): string {
  const reply = r.reply ? [r.reply.comment, r.reply.updateTime] : null;
  return createHash("sha256")
    .update(JSON.stringify([r.starRating, r.comment, r.updateTime, reply]))
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
}

export async function loadCache(subAccountId: string): Promise<Map<string, CachedReview>> {
  const snap = await getAdminDb().collection(reviewsCollection(subAccountId)).get();
  const out = new Map<string, CachedReview>();
  for (const doc of snap.docs) {
    const d = doc.data() as Partial<GbpReviewDoc>;
    out.set(doc.id, {
      state: d.state === "removed" ? "removed" : "active",
      passId: d.passId ?? "",
      lastSeenAt: toMillis(d.lastSeenAt),
      contentHash: d.contentHash ?? null,
      missedPasses: typeof d.missedPasses === "number" ? d.missedPasses : 0,
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
): { kind: UpsertKind; data: Record<string, unknown>; merge: boolean } {
  const hash = contentHash(review);
  // Seeing a review resets its miss count.
  const seen = { lastSeenAt: ctx.now, passId: ctx.passId, missedPasses: 0 };
  // A tombstone's contentHash is null, so a review that comes back is an update.
  if (cached && cached.contentHash === hash) {
    return { kind: "unchanged", data: seen, merge: true };
  }
  const content = {
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
  if (cached) return { kind: "updated", data: content, merge: true };
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
  };
  return { kind: "created", data: doc as unknown as Record<string, unknown>, merge: false };
}

/** A removed review keeps only its ids and when it went — no content, no rating. */
export function tombstone(now: Date): Record<string, unknown> {
  return {
    state: "removed", removedAt: now, comment: null, reviewer: null, reply: null, starRating: null, contentHash: null,
  };
}

const BATCH = 400;

async function deleteAll(paths: string[]): Promise<void> {
  const db = getAdminDb();
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = db.batch();
    for (const p of paths.slice(i, i + BATCH)) batch.delete(db.doc(p));
    await batch.commit();
  }
}

/** The lease a cache clear holds while it deletes (an ordinary lease: it expires). */
export const CLEARING_RUN_ID = "clearing";

/**
 * Drop EVERYTHING synced for a sub-account: every cached review, the summary
 * and the sync state (lease + cursor). Called whenever the listing is cleared
 * or replaced, or the agency gate goes off — the cache only ever holds the
 * current listing.
 *
 * FIRST it takes the lease (`runId: "clearing"`): a run in flight fails its
 * next guarded write (lease lost) and a run starting now is refused
 * (`already_running`), so nothing lands behind the deletes. The state doc —
 * and with it the clearing lease — goes LAST. A clear that dies midway leaves
 * the lease to expire after its TTL.
 */
export async function clearGbpCache(subAccountId: string): Promise<void> {
  const db = getAdminDb();
  const stateRef = db.doc(syncStatePath(subAccountId));
  // The first write also drops the cursor and the anomaly streak, so a clear
  // that dies midway leaves no stale pass for the next run to resume.
  const lease = { runId: CLEARING_RUN_ID, until: Date.now() + LEASE_TTL_MS };
  await stateRef.set({ lease, pass: null, anomalyStreak: null }, { merge: true });
  const snap = await db.collection(reviewsCollection(subAccountId)).get();
  await deleteAll(snap.docs.map((d) => `${reviewsCollection(subAccountId)}/${d.id}`));
  await db.doc(`subAccounts/${subAccountId}`).set({ gbpSummary: null }, { merge: true });
  await stateRef.delete();
}

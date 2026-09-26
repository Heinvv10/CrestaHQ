import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { withGbpAccess } from "../access";
import { sendAutoReplyAlert } from "@/lib/reputation/auto-reply/alerts";
import { GbpProviderError, type GbpReview, type GbpReviewsPage } from "../provider/types";
import { autoReplyNeverPath, neverMarker } from "../auto-reply-never";
import { commitGuarded, type GuardedOp } from "./lease";
import { withRetry, type Sleep } from "./retry";
import { reviewDocId, upsertFor, type CachedReview, type UpsertContext } from "./store";
import { LEASE_TTL_MS, PASS_MAX_AGE_MS, reviewsCollection, syncStatePath, type SyncPass, type SyncState } from "./types";

/**
 * Fetch one run's share of a pass: resume a young pass from its cursor (else
 * start a new one), page through `listReviews` up to `maxPages`, upsert each
 * page and persist the cursor in the SAME guarded transaction. Every provider
 * call goes through withGbpAccess (401 → refresh once → revoked is flagged)
 * and withRetry. A resumed cursor Google rejects restarts the pass from page
 * 1 once, keeping its id. The pass remembers the first non-null rating and
 * count Google reported (a later page's null never overwrites them), and each
 * page commit renews the lease.
 */

export interface PassInput {
  subAccountId: string;
  runId: string;
  ref: { accountName: string; locationName: string };
  ctx: Omit<UpsertContext, "passId">;
  cache: Map<string, CachedReview>;
  pass: SyncState["pass"];
  maxPages: number;
  sleep: Sleep;
  /** Wall clock for lease renewal (tests inject one). */
  clock: () => Date;
}

export interface PassOutcome {
  passId: string;
  resumed: boolean;
  pagesFetched: number;
  reviewsSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Every page of the pass has now been fetched. */
  complete: boolean;
  /** The pass's rating/count: first non-null values Google reported in it. */
  averageRating: number | null;
  totalReviewCount: number | null;
  /** What stopped the run early, if anything. */
  error: unknown;
}

const STALE_CURSOR = new Set(["not_found", "malformed"]);

export async function fetchPass(input: PassInput): Promise<PassOutcome> {
  const { subAccountId, runId, ref, cache, maxPages, sleep } = input;
  const nowMs = input.ctx.now.getTime();
  const young = input.pass && nowMs - input.pass.startedAt < PASS_MAX_AGE_MS ? input.pass : null;
  const passId = young?.passId ?? randomUUID();
  const startedAt = young?.startedAt ?? nowMs;
  let pagesDone = young?.pagesDone ?? 0;
  let token: string | undefined = young?.pageToken ?? undefined;
  const out: PassOutcome = {
    passId, resumed: !!token, pagesFetched: 0, reviewsSeen: 0, created: 0, updated: 0,
    unchanged: 0, complete: false, error: null,
    averageRating: young?.averageRating ?? null,
    totalReviewCount: young?.totalReviewCount ?? null,
  };
  let mayRestart = out.resumed;
  const db = getAdminDb();
  const stateRef = db.doc(syncStatePath(subAccountId));
  const ctx: UpsertContext = { ...input.ctx, passId };

  while (out.pagesFetched < maxPages) {
    let page: GbpReviewsPage;
    try {
      page = await withRetry(
        () => withGbpAccess(subAccountId, (p, accessToken) => p.listReviews(accessToken, ref, token)),
        sleep,
      );
    } catch (err) {
      if (mayRestart && err instanceof GbpProviderError && STALE_CURSOR.has(err.kind)) {
        mayRestart = false;
        token = undefined;
        pagesDone = 0;
        continue;
      }
      out.error = err;
      return out;
    }
    mayRestart = false;

    const ops: GuardedOp[] = [];
    const counts = { created: 0, updated: 0, unchanged: 0 };
    const editedLow: { review: GbpReview; docId: string }[] = [];
    for (const review of page.reviews) {
      const docId = reviewDocId(review.name);
      const cached = cache.get(docId);
      const { kind, data, merge, markNever, editedLow: lowered } = upsertFor(review, cached, ctx);
      if (lowered) editedLow.push({ review, docId });
      const docRef = db.doc(`${reviewsCollection(subAccountId)}/${docId}`);
      ops.push((tx) => (merge ? tx.set(docRef, data, { merge: true }) : tx.set(docRef, data)));
      if (markNever) {
        const marker = neverMarker(ctx, "replied", ctx.now, docId);
        ops.push((tx) => tx.set(db.doc(autoReplyNeverPath(subAccountId, review.name)), marker, { merge: true }));
      }
      counts[kind] += 1;
      // Run-local view, so a review repeated on a later page is "unchanged".
      const hash = kind === "unchanged" ? (cached?.contentHash ?? null) : (data.contentHash as string);
      const replied = data.hadReply === true || cached?.replied === true;
      const autoRepliedStar = cached?.autoRepliedStar == null ? null : review.starRating;
      cache.set(docId, { state: "active", passId, lastSeenAt: nowMs, contentHash: hash, replied, hadReply: replied, autoRepliedStar });
    }
    const next = page.nextPageToken;
    pagesDone += 1;
    const averageRating = out.averageRating ?? page.averageRating;
    const totalReviewCount = out.totalReviewCount ?? page.totalReviewCount;
    const pass: SyncPass = { passId, pageToken: next, pagesDone, startedAt, averageRating, totalReviewCount };
    const lease = { runId, until: input.clock().getTime() + LEASE_TTL_MS };
    ops.push((tx) => tx.set(stateRef, { pass, lease }, { merge: true }));
    try {
      await commitGuarded(subAccountId, runId, ops);
    } catch (err) {
      out.error = err;
      return out;
    }

    // Only once the page is committed: one alert per review, ever (alerts.ts).
    for (const { review, docId } of editedLow) {
      await sendAutoReplyAlert(subAccountId, {
        kind: "edited_low", reviewName: review.name, reviewDocId: docId, star: review.starRating, comment: review.comment,
      });
    }
    out.pagesFetched += 1;
    out.reviewsSeen += page.reviews.length;
    out.created += counts.created;
    out.updated += counts.updated;
    out.unchanged += counts.unchanged;
    out.averageRating = averageRating;
    out.totalReviewCount = totalReviewCount;
    if (!next) {
      out.complete = true;
      return out;
    }
    token = next;
  }
  return out;
}

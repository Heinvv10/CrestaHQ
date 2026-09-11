import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { withGbpAccess } from "../access";
import { GbpProviderError, type GbpReviewsPage } from "../provider/types";
import { commitGuarded, type GuardedOp } from "./lease";
import { withRetry, type Sleep } from "./retry";
import { reviewDocId, upsertFor, type CachedReview, type UpsertContext } from "./store";
import { PASS_MAX_AGE_MS, reviewsCollection, syncStatePath, type SyncState } from "./types";

/**
 * Fetch one run's share of a pass: resume a young pass from its cursor (else
 * start a new one), page through `listReviews` up to `maxPages`, upsert each
 * page and persist the cursor in the SAME guarded transaction. Every provider
 * call goes through withGbpAccess (401 → refresh once → revoked is flagged)
 * and withRetry. A resumed cursor Google rejects restarts the pass from page
 * 1 once, keeping its id.
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
  lastPage: GbpReviewsPage | null;
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
    unchanged: 0, complete: false, lastPage: null, error: null,
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
    for (const review of page.reviews) {
      const docId = reviewDocId(review.name);
      const cached = cache.get(docId);
      const { kind, data, merge } = upsertFor(review, cached, ctx);
      const docRef = db.doc(`${reviewsCollection(subAccountId)}/${docId}`);
      ops.push((tx) => (merge ? tx.set(docRef, data, { merge: true }) : tx.set(docRef, data)));
      counts[kind] += 1;
      // Run-local view, so a review repeated on a later page is "unchanged".
      const hash = kind === "unchanged" ? (cached?.contentHash ?? null) : (data.contentHash as string);
      cache.set(docId, { state: "active", passId, lastSeenAt: nowMs, contentHash: hash });
    }
    const next = page.nextPageToken;
    pagesDone += 1;
    const pass = { passId, pageToken: next, pagesDone, startedAt };
    ops.push((tx) => tx.set(stateRef, { pass }, { merge: true }));
    try {
      await commitGuarded(subAccountId, runId, ops);
    } catch (err) {
      out.error = err;
      return out;
    }

    out.pagesFetched += 1;
    out.reviewsSeen += page.reviews.length;
    out.created += counts.created;
    out.updated += counts.updated;
    out.unchanged += counts.unchanged;
    out.lastPage = page;
    if (!next) {
      out.complete = true;
      return out;
    }
    token = next;
  }
  return out;
}

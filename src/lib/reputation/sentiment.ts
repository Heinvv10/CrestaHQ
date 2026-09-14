import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";
import { reviewsAiConfigured } from "./ai/mode";
import { getReviewsAiFor } from "./ai/select";
import { REVIEWS_AI_BATCH, type ReviewsAi, type SentimentLabel } from "./ai/types";
import { aiRetryAllowed, currentSentiment, ratingLabel, reviewBasis, type SentimentSource } from "./sentiment-basis";
import { acquireSentimentLease, markPendingUnknown, releaseSentimentLease, renewSentimentLease } from "./sentiment-lease";

/**
 * Review sentiment (SP5 b): `sentiment {label, method, basisHash, model, at}`
 * cached on each `gbpReviews` doc; `sentimentAttempt {basisHash, failures,
 * lastAt}` counts failed analyses of the current content.
 *
 *   - Eligible: the reviews inbox's own set (`loadServedReviews`) whose label
 *     is missing or stale (basis ≠ `sentimentBasis(stars, comment)`), unless
 *     its current content already failed 3 times or failed within the hour.
 *   - Star-only: labelled from the stars, no AI call, one transaction per ≤100.
 *   - With text: ONE review per AI call; right before each call the review is
 *     re-read and dropped if it changed, was removed or is already labelled.
 *   - NEVER RE-BILLED: the basis check, the attempt limit, and one lease per
 *     sub-account that only its owner can renew (a lost lease stops the run).
 *     Each label / failure is written in a transaction that re-checks the basis.
 *   - At most `max` (default 100) reviews per run, newest first.
 * Runs AFTER the response (sentiment-after.ts), never inside a sync.
 */

export const SENTIMENT_MAX_PER_RUN = 100;
const STAR_WRITE_BATCH = 100;

export type SentimentMethod = "rating" | "ai";
export interface SentimentCounts {
  /** Labels written this run. */
  classified: number;
  /** Eligible but not attempted (over the cap, AI not configured, lease lost) or dropped (changed mid-run). */
  skipped: number;
  /** Sent to the AI but not labelled (bad output, failed call, refused provider). */
  failed: number;
}
export type SentimentSkip = "gate_off" | "google_gate_off" | "no_listing" | "busy";
export interface SentimentOutcome extends SentimentCounts {
  status: "ran" | "skipped";
  skipReason: SentimentSkip | null;
  aiConfigured: boolean;
}

interface Pending {
  docId: string;
  starRating: number;
  comment: string | null;
  basis: string;
}

const isStarOnly = (comment: string | null) => comment === null || comment.trim() === "";
const reviewRef = (sa: string, docId: string) => getAdminDb().doc(`${reviewsCollection(sa)}/${docId}`);
type ReviewData = SentimentSource & { state?: string };

/** Still the same active content, and not already labelled for it? */
function stillPending(d: ReviewData | undefined, p: Pending): boolean {
  return d?.state === "active" && reviewBasis(d) === p.basis && currentSentiment(d) === null;
}

/** Star-only labels, one transaction per ≤100 reviews. Returns how many were written. */
async function writeRatingLabels(sa: string, items: Pending[], now: Date): Promise<number> {
  let written = 0;
  for (let i = 0; i < items.length; i += STAR_WRITE_BATCH) {
    const chunk = items.slice(i, i + STAR_WRITE_BATCH);
    written += await getAdminDb().runTransaction(async (tx) => {
      const docs: Array<ReviewData | undefined> = [];
      for (const p of chunk) docs.push((await tx.get(reviewRef(sa, p.docId))).data() as ReviewData | undefined);
      let n = 0;
      chunk.forEach((p, k) => {
        if (!stillPending(docs[k], p)) return;
        const sentiment = { label: ratingLabel(p.starRating), method: "rating", basisHash: p.basis, model: null, at: now };
        tx.update(reviewRef(sa, p.docId), { sentiment, sentimentAttempt: null });
        n++;
      });
      return n;
    });
  }
  return written;
}

/** Label, or record a failed attempt — either only if the review still has the classified content. */
async function recordResult(sa: string, p: Pending, label: SentimentLabel | null, model: string, now: Date) {
  const ref = reviewRef(sa, p.docId);
  return getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as ReviewData | undefined;
    if (d?.state !== "active" || reviewBasis(d) !== p.basis) return false;
    if (label) {
      tx.update(ref, { sentiment: { label, method: "ai", basisHash: p.basis, model, at: now }, sentimentAttempt: null });
    } else {
      const a = d.sentimentAttempt;
      const failures = a?.basisHash === p.basis && typeof a.failures === "number" ? a.failures + 1 : 1;
      tx.update(ref, { sentimentAttempt: { basisHash: p.basis, failures, lastAt: now } });
    }
    return true;
  });
}

async function classifyText(sa: string, runId: string, text: Pending[], counts: SentimentCounts, now: Date) {
  let ai: ReviewsAi;
  try {
    ai = await getReviewsAiFor(sa);
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${sa} provider refused kind=${err instanceof Error ? err.name : typeof err}`);
    counts.failed += text.length;
    return;
  }
  for (let i = 0; i < text.length; i += REVIEWS_AI_BATCH) {
    // Only the lease's owner may go on: an expired lease another run took stops this one.
    if (!(await renewSentimentLease(sa, runId, Date.now()))) {
      counts.skipped += text.length - i;
      return;
    }
    const batch: Pending[] = [];
    for (const p of text.slice(i, i + REVIEWS_AI_BATCH)) {
      const d = (await reviewRef(sa, p.docId).get()).data() as ReviewData | undefined;
      if (stillPending(d, p) && aiRetryAllowed(d!, now.getTime())) batch.push(p);
      else counts.skipped++;
    }
    if (!batch.length) continue;
    const labels = new Map(
      (await ai.classifySentiment(batch.map((p) => ({ id: p.docId, starRating: p.starRating, text: p.comment ?? "" })))).map(
        (r) => [r.id, r.label],
      ),
    );
    for (const p of batch) {
      const label = labels.get(p.docId) ?? null;
      const wrote = await recordResult(sa, p, label, ai.model, now);
      if (label && wrote) counts.classified++;
      else if (label) counts.skipped++;
      else counts.failed++;
    }
  }
}

export async function classifyPendingSentiment(
  subAccountId: string,
  opts: { max?: number; now?: Date; heldRunId?: string } = {},
): Promise<SentimentOutcome> {
  const now = opts.now ?? new Date();
  const counts: SentimentCounts = { classified: 0, skipped: 0, failed: 0 };
  const aiConfigured = reviewsAiConfigured();
  const runId = opts.heldRunId ?? randomUUID();
  const skip = async (skipReason: SentimentSkip): Promise<SentimentOutcome> => {
    if (skipReason !== "busy") {
      if (opts.heldRunId) await releaseSentimentLease(subAccountId, runId, { pending: null });
      else await markPendingUnknown(subAccountId);
    }
    return { status: "skipped", skipReason, aiConfigured, ...counts };
  };

  const sub = ((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubAccountDoc;
  if (sub.reviewsAiEnabledByAgency !== true) return skip("gate_off");
  if (sub.googleEnabledByAgency !== true) return skip("google_gate_off");
  const locationName = sub.googleListing?.locationName ?? null;
  if (!locationName) return skip("no_listing");
  if (!opts.heldRunId && !(await acquireSentimentLease(subAccountId, runId, now.getTime()))) return skip("busy");

  try {
    const { reviews } = await loadServedReviews(subAccountId, locationName, now);
    const pending: Pending[] = reviews.flatMap((r) => {
      const basis = reviewBasis(r);
      if (basis === null || currentSentiment(r) !== null) return [];
      const comment = typeof r.comment === "string" ? r.comment : null;
      if (!isStarOnly(comment) && !aiRetryAllowed(r, now.getTime())) return [];
      return [{ docId: String(r.docId), starRating: r.starRating as number, comment, basis }];
    });
    const max = opts.max ?? SENTIMENT_MAX_PER_RUN;
    counts.skipped += Math.max(0, pending.length - max);
    const batch = pending.slice(0, max);

    const stars = batch.filter((x) => isStarOnly(x.comment));
    const written = await writeRatingLabels(subAccountId, stars, now);
    counts.classified += written;
    counts.skipped += stars.length - written;
    const text = batch.filter((x) => !isStarOnly(x.comment));
    if (!aiConfigured) counts.skipped += text.length;
    else if (text.length) await classifyText(subAccountId, runId, text, counts, now);
  } finally {
    await releaseSentimentLease(subAccountId, runId, {
      pending: counts.skipped + counts.failed,
      lastRun: { ...counts, at: now },
    });
  }
  return { status: "ran", skipReason: null, aiConfigured, ...counts };
}

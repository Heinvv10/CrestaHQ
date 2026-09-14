import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";
import { reviewsAiConfigured } from "./ai/mode";
import { getReviewsAiFor } from "./ai/select";
import { REVIEWS_AI_BATCH, type ReviewsAi } from "./ai/types";
import { aiRetryAllowed, currentSentiment, ratingLabel, reviewBasis, type SentimentSource } from "./sentiment-basis";
import { beginCall, finishCall, type StopReason } from "./sentiment-calls";
import { acquireSentimentLease, releaseSentimentLease } from "./sentiment-lease";

/**
 * Review sentiment (SP5 b): `sentiment {label, method, basisHash, model, at}`
 * cached on each `gbpReviews` doc; `sentimentAttempt {basisHash, failures,
 * lastAt}` counts analyses of the current content that did not produce a label.
 *
 *   - Eligible: the reviews inbox's own set (`loadServedReviews`) whose label
 *     is missing or stale (basis ≠ `sentimentBasis(stars, comment)`), unless
 *     its current content already failed 3 times or failed within the hour.
 *   - Star-only: labelled from the stars, no AI call, one transaction per ≤100.
 *   - With text: ONE review per AI call. Before each call `beginCall` (one
 *     transaction) re-reads the lease, the gates, the listing, the daily
 *     usage and the review; it stops the run, drops the review, or counts the
 *     call and writes a strike. After it, `finishCall` records the label or
 *     undoes the strike of a call that never reached the model.
 *   - NEVER RE-BILLED on re-sync: the basis check, the attempt limit, one
 *     lease per sub-account renewable only by its owner, a daily cap of 300
 *     calls, and a 240 s budget per run.
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
  /** Why a run that started stopped before the end (the rest counted as skipped). */
  stopped: StopReason | null;
  aiConfigured: boolean;
}

/** Stop starting new AI calls after this long (routes allow 300 s). */
export const SENTIMENT_RUN_BUDGET_MS = 240_000;

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

async function classifyText(
  sa: string,
  runId: string,
  locationName: string,
  text: Pending[],
  counts: SentimentCounts,
  now: Date,
  deadline: number,
): Promise<StopReason | null> {
  let ai: ReviewsAi;
  try {
    ai = await getReviewsAiFor(sa);
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${sa} provider refused kind=${err instanceof Error ? err.name : typeof err}`);
    counts.failed += text.length;
    return null;
  }
  for (let i = 0; i < text.length; i += REVIEWS_AI_BATCH) {
    if (Date.now() >= deadline) {
      counts.skipped += text.length - i;
      return "budget";
    }
    const batch: Array<Pending & { begun: { previous: unknown; failures: number } }> = [];
    for (const p of text.slice(i, i + REVIEWS_AI_BATCH)) {
      const begun = await beginCall(sa, runId, locationName, p);
      if (!begun.go && "stop" in begun) {
        counts.skipped += text.length - i;
        return begun.stop;
      }
      if (!begun.go) counts.skipped++;
      else batch.push({ ...p, begun });
    }
    if (!batch.length) continue;
    const results = await ai.classifySentiment(batch.map((p) => ({ id: p.docId, starRating: p.starRating, text: p.comment ?? "" })));
    for (const p of batch) {
      const r = results.find((x) => x.id === p.docId);
      if (r?.label) {
        if (await finishCall(sa, p, { kind: "label", label: r.label, model: ai.model, at: now })) counts.classified++;
        else counts.skipped++;
      } else {
        counts.failed++;
        if (r?.failure === "transport") {
          await finishCall(sa, p, { kind: "transport", previous: p.begun.previous as never, failures: p.begun.failures });
        }
      }
    }
  }
  return null;
}

export async function classifyPendingSentiment(
  subAccountId: string,
  opts: { max?: number; now?: Date; heldRunId?: string } = {},
): Promise<SentimentOutcome> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + SENTIMENT_RUN_BUDGET_MS;
  const counts: SentimentCounts = { classified: 0, skipped: 0, failed: 0 };
  const aiConfigured = reviewsAiConfigured();
  const runId = opts.heldRunId ?? randomUUID();
  let held = !!opts.heldRunId;
  let skipReason: SentimentSkip | null = null;
  let stopped: StopReason | null = null;
  let complete = false;

  try {
    const sub = ((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubAccountDoc;
    const locationName = sub.googleListing?.locationName ?? null;
    if (sub.reviewsAiEnabledByAgency !== true) skipReason = "gate_off";
    else if (sub.googleEnabledByAgency !== true) skipReason = "google_gate_off";
    else if (!locationName) skipReason = "no_listing";
    else if (!held && !(held = await acquireSentimentLease(subAccountId, runId, now.getTime()))) skipReason = "busy";
    if (skipReason) return { status: "skipped", skipReason, stopped, aiConfigured, ...counts };

    const { reviews } = await loadServedReviews(subAccountId, locationName!, now);
    const pending: Pending[] = reviews.flatMap((r) => {
      const basis = reviewBasis(r);
      if (basis === null || currentSentiment(r) !== null) return [];
      const comment = typeof r.comment === "string" ? r.comment : null;
      if (!isStarOnly(comment) && !aiRetryAllowed(r, Date.now())) return [];
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
    else if (text.length) stopped = await classifyText(subAccountId, runId, locationName!, text, counts, now, deadline);
    complete = stopped === null;
    return { status: "ran", skipReason: null, stopped, aiConfigured, ...counts };
  } finally {
    // Always released when held (a throw included); lastCompleteAt only on a normal finish.
    if (held) {
      const reason = skipReason ?? stopped;
      await releaseSentimentLease(subAccountId, runId, { lastRun: { ...counts, at: now, reason }, complete });
    }
  }
}

import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";
import { reviewsAiConfigured } from "./ai/mode";
import { getReviewsAiFor } from "./ai/select";
import type { ReviewsAi } from "./ai/types";
import {
  aiRetryAllowed,
  currentSentiment,
  lastAttemptAt,
  ratingLabel,
  reviewBasis,
  sentimentGaveUp,
  type SentimentSource,
} from "./sentiment-basis";
import { beginCall, finishCall, uncountStrike, type StopReason } from "./sentiment-calls";
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
 *   - With text: ONE review per AI call. Immediately before each call
 *     `beginCall` (one transaction) re-reads the lease, the gates, the
 *     listing, the daily usage and the review; it stops the run, drops the
 *     review, or counts the call and writes a strike. A label clears the
 *     strike (`finishCall`); a transient failure un-counts it; a rejected or
 *     unusable answer keeps it. Any failure stops the run. Reviews already
 *     tried queue after fresh ones.
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
  /** Sent to the AI but not labelled (a bad answer, a failed call, or a label that could not be saved). */
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

/**
 * Text reviews, one AI call each, `beginCall` immediately before its call.
 * The run STOPS on the first failure of any kind: `ai_error` (transient —
 * no strike), `ai_bad_answer` (a strike), `save_failed` (a strike). So an
 * outage costs one call per run and one bad review costs one call per hour,
 * never the backlog. Returns the stop reason, or null when all were handled.
 */
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
    counts.skipped += text.length;
    return "ai_error";
  }
  for (let i = 0; i < text.length; i++) {
    const rest = () => (counts.skipped += text.length - i - 1);
    if (Date.now() >= deadline) {
      counts.skipped += text.length - i;
      return "budget";
    }
    const p = text[i];
    const begun = await beginCall(sa, runId, locationName, p);
    if (!begun.go) {
      if ("stop" in begun) {
        counts.skipped += text.length - i;
        return begun.stop;
      }
      counts.skipped++;
      continue;
    }
    let r: Awaited<ReturnType<ReviewsAi["classifySentiment"]>>[number] | undefined;
    try {
      [r] = await ai.classifySentiment([{ id: p.docId, starRating: p.starRating, text: p.comment ?? "" }]);
    } catch (err) {
      console.warn(`[reputation/sentiment] sa=${sa} ai call threw kind=${err instanceof Error ? err.name : typeof err}`);
      r = { id: p.docId, label: null, failure: "call_failed" };
    }
    if (!r?.label) {
      counts.failed++;
      rest();
      if (r?.failure !== "call_failed") return "ai_bad_answer"; // rejected or unusable: the strike stays
      // Transient: not a strike, but lastAt still waits an hour. If the un-count
      // itself fails the strike stays — conservative: at worst one strike too many.
      try {
        await uncountStrike(sa, p, begun.failures);
      } catch (err) {
        console.warn(`[reputation/sentiment] sa=${sa} strike not un-counted kind=${err instanceof Error ? err.name : typeof err}`);
      }
      return "ai_error";
    }
    try {
      if (await finishCall(sa, p, r.label, ai.model, now)) counts.classified++;
      else counts.skipped++; // changed while it was classified
    } catch (err) {
      // Billed, not saved: the strike stays.
      console.warn(`[reputation/sentiment] sa=${sa} label not saved; run stops kind=${err instanceof Error ? err.name : typeof err}`);
      counts.failed++;
      rest();
      return "save_failed";
    }
  }
  return null;
}

export async function classifyPendingSentiment(
  subAccountId: string,
  opts: { max?: number; now?: Date; heldRunId?: string; /** Shared by every run of one request. */ deadline?: number } = {},
): Promise<SentimentOutcome> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + SENTIMENT_RUN_BUDGET_MS;
  const counts: SentimentCounts = { classified: 0, skipped: 0, failed: 0 };
  const aiConfigured = reviewsAiConfigured();
  const runId = opts.heldRunId ?? randomUUID();
  let held = !!opts.heldRunId;
  let skipReason: SentimentSkip | null = null;
  let stopped: StopReason | null = null;
  let complete = false;
  let returned = false;

  try {
    const sub = ((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubAccountDoc;
    const locationName = sub.googleListing?.locationName ?? null;
    if (sub.reviewsAiEnabledByAgency !== true) skipReason = "gate_off";
    else if (sub.googleEnabledByAgency !== true) skipReason = "google_gate_off";
    else if (!locationName) skipReason = "no_listing";
    else if (!held && !(held = await acquireSentimentLease(subAccountId, runId, now.getTime()))) skipReason = "busy";
    if (skipReason) {
      returned = true;
      return { status: "skipped", skipReason, stopped, aiConfigured, ...counts };
    }

    const { reviews } = await loadServedReviews(subAccountId, [locationName!], now);
    let waiting = 0; // text reviews in their retry hour (not given up): a later run owes them a call
    const eligible = reviews.flatMap((r) => {
      const basis = reviewBasis(r);
      if (basis === null || currentSentiment(r) !== null) return [];
      const comment = typeof r.comment === "string" ? r.comment : null;
      if (!isStarOnly(comment) && !aiRetryAllowed(r, Date.now())) {
        if (!sentimentGaveUp(r)) waiting++;
        return [];
      }
      return [{ docId: String(r.docId), starRating: r.starRating as number, comment, basis, tried: lastAttemptAt(r) }];
    });
    // Fresh reviews first (newest first, as served), then ones already tried,
    // longest-waiting first — one troublesome review can never block the backlog.
    const pending: Pending[] = [
      ...eligible.filter((x) => x.tried === null),
      ...eligible.filter((x) => x.tried !== null).sort((a, b) => (a.tried as number) - (b.tried as number)),
    ].map(({ tried: _tried, ...p }) => p);
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
    // Complete only if nothing stopped it, the 100 cap left nothing behind, no
    // text review is waiting out its retry hour, and none is waiting for an AI.
    complete = stopped === null && pending.length <= max && waiting === 0 && (aiConfigured || text.length === 0);
    returned = true;
    return { status: "ran", skipReason: null, stopped, aiConfigured, ...counts };
  } finally {
    // Always released when held (a throw included); lastCompleteAt only on a complete run.
    if (held) {
      const reason = returned ? (skipReason ?? stopped) : "error";
      await releaseSentimentLease(subAccountId, runId, { lastRun: { ...counts, at: now, reason }, complete });
    }
  }
}

import "server-only";

import { createHash } from "node:crypto";
import { toMillis } from "@/lib/gbp/sync/types";
import { SENTIMENT_LABELS, type SentimentLabel } from "./ai/types";

/**
 * What a sentiment label was derived from, and which labels a reader may
 * show. A sync edit overwrites a review's content but not its `sentiment`
 * (the upsert hashes the owner reply too — blanking there would re-bill on
 * every reply), so EVERY reader re-derives: a label whose `basisHash` is not
 * the review's current basis is stale and reads as absent.
 */

/** A bad AI answer: the content is tried at most this many times (a failed call does not count). */
export const MAX_SENTIMENT_FAILURES = 3;
/** …and at most once an hour — after a bad answer or a failed call. */
export const SENTIMENT_RETRY_AFTER_MS = 3600_000;

export function sentimentBasis(starRating: number | null, comment: string | null): string {
  return createHash("sha256").update(`${starRating ?? ""}\n${comment ?? ""}`).digest("hex");
}

export function ratingLabel(stars: number): SentimentLabel {
  return stars >= 4 ? "positive" : stars === 3 ? "neutral" : "negative";
}

/** The fields of a cached review this module reads. */
export interface SentimentSource {
  starRating?: unknown;
  comment?: unknown;
  sentiment?: { label?: unknown; method?: unknown; basisHash?: unknown } | null;
  sentimentAttempt?: { basisHash?: unknown; failures?: unknown; lastAt?: unknown } | null;
}

/** The review's current basis; null when it has no star rating (nothing to classify). */
export function reviewBasis(d: SentimentSource): string | null {
  if (typeof d.starRating !== "number") return null;
  return sentimentBasis(d.starRating, typeof d.comment === "string" ? d.comment : null);
}

/** The label a reader may show: only one derived from the review's CURRENT content. */
export function currentSentiment(d: SentimentSource): { label: SentimentLabel; method: string } | null {
  const s = d.sentiment;
  const basis = reviewBasis(d);
  if (!s || basis === null || s.basisHash !== basis) return null;
  if (typeof s.method !== "string" || !(SENTIMENT_LABELS as readonly unknown[]).includes(s.label)) return null;
  return { label: s.label as SentimentLabel, method: s.method };
}

/** Failed analyses recorded for the review's current content (0 when none, or for older content). */
function failuresNow(d: SentimentSource): { failures: number; lastAt: number | null } {
  const a = d.sentimentAttempt;
  const basis = reviewBasis(d);
  if (!a || basis === null || a.basisHash !== basis) return { failures: 0, lastAt: null };
  return { failures: typeof a.failures === "number" ? a.failures : 0, lastAt: toMillis(a.lastAt) };
}

/**
 * When the current content was last tried and not labelled (a strike or a
 * transient failure); null when it never was. Orders the queue: fresh first.
 */
export function lastAttemptAt(d: SentimentSource): number | null {
  const a = d.sentimentAttempt;
  const basis = reviewBasis(d);
  return a && basis !== null && a.basisHash === basis ? toMillis(a.lastAt) : null;
}

/** Given up: the AI rejected or answered the current content badly MAX_SENTIMENT_FAILURES times ("couldn't be analysed"). */
export function sentimentGaveUp(d: SentimentSource): boolean {
  return currentSentiment(d) === null && failuresNow(d).failures >= MAX_SENTIMENT_FAILURES;
}

/** May the current content be sent to the AI now? No after 3 failures, nor within an hour of the last. */
export function aiRetryAllowed(d: SentimentSource, now: number): boolean {
  const { failures, lastAt } = failuresNow(d);
  if (failures >= MAX_SENTIMENT_FAILURES) return false;
  return lastAt === null || now - lastAt >= SENTIMENT_RETRY_AFTER_MS;
}

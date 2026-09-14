import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import type { SentimentLabel } from "./ai/types";
import { aiRetryAllowed, currentSentiment, reviewBasis, type SentimentSource } from "./sentiment-basis";
import { SENTIMENT_LEASE_TTL_MS, sentimentLeasePath } from "./sentiment-lease";

/**
 * One AI call's bookkeeping, in transactions (SP5 b):
 *
 *   beginCall   BEFORE the call, one transaction that re-reads the lease, the
 *               sub-account, the daily usage and the review, and either stops
 *               the run (lease lost, a gate switched off, the listing changed,
 *               the daily cap reached), drops this review (changed, removed,
 *               labelled meanwhile, in its retry wait or given up), or renews
 *               the lease, counts the call and writes a STRIKE on the review
 *               (`sentimentAttempt.failures + 1`). A crash after this keeps
 *               the strike — conservative: it counts toward the three.
 *   finishCall  AFTER it: a label clears the strike (also on a review
 *               tombstoned during its call — a 3-value label, no content).
 *   A bad answer from the model keeps the strike; a failed CALL (outage,
 *   revoked key, no credits, timeout) is un-counted by `uncountStrike` — its
 *   `lastAt` still spaces the retry by an hour — so an outage never gives up
 *   on a review. Either way the run stops on its first failure.
 * At most one call is ever in flight per sub-account, so a gate switched off
 * lets at most that one call finish.
 */

/**
 * AI calls per sub-account per UTC day — a hard spend bound, not configurable.
 * Counted by the day of the transaction that starts the call; a call in flight
 * across midnight can make one more than 300 fall in a calendar day.
 */
export const DAILY_AI_CALL_CAP = 300;

export const sentimentUsagePath = (sa: string) => `subAccounts/${sa}/private/sentimentUsage`;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type StopReason =
  | "lease_lost"
  | "gate_off"
  | "google_gate_off"
  | "listing_changed"
  | "daily_cap"
  | "budget"
  /** A transient AI failure (no response, timeout, 401/402/408/429/5xx) or no provider: not a strike. */
  | "ai_error"
  /** The AI rejected or answered this review unusably: a strike. */
  | "ai_bad_answer"
  /** A label came back but could not be written (the strike stays). */
  | "save_failed";

export interface CallItem {
  docId: string;
  basis: string;
}
type ReviewData = SentimentSource & { state?: string };
export type Attempt = { basisHash?: unknown; failures?: unknown; lastAt?: unknown } | null;
export type BeginResult = { go: true; failures: number } | { go: false; stop: StopReason } | { go: false; drop: true };

export async function beginCall(sa: string, runId: string, locationName: string, p: CallItem): Promise<BeginResult> {
  const db = getAdminDb();
  const leaseRef = db.doc(sentimentLeasePath(sa));
  const subRef = db.doc(`subAccounts/${sa}`);
  const usageRef = db.doc(sentimentUsagePath(sa));
  const reviewRef = db.doc(`${reviewsCollection(sa)}/${p.docId}`);
  return db.runTransaction(async (tx) => {
    const lease = (await tx.get(leaseRef)).data() as { runId?: string } | undefined;
    const sub = (await tx.get(subRef)).data() as
      | { reviewsAiEnabledByAgency?: boolean; googleEnabledByAgency?: boolean; googleListing?: { locationName?: string } | null }
      | undefined;
    const usage = (await tx.get(usageRef)).data() as { day?: string; calls?: number } | undefined;
    const review = (await tx.get(reviewRef)).data() as ReviewData | undefined;
    const now = Date.now();

    if (lease?.runId !== runId) return { go: false, stop: "lease_lost" } as const;
    if (sub?.reviewsAiEnabledByAgency !== true) return { go: false, stop: "gate_off" } as const;
    if (sub.googleEnabledByAgency !== true) return { go: false, stop: "google_gate_off" } as const;
    if (sub.googleListing?.locationName !== locationName) return { go: false, stop: "listing_changed" } as const;
    const day = utcDay(now);
    const calls = usage?.day === day ? (usage.calls ?? 0) : 0;
    if (calls >= DAILY_AI_CALL_CAP) return { go: false, stop: "daily_cap" } as const;
    const pending = review?.state === "active" && reviewBasis(review) === p.basis && currentSentiment(review) === null;
    if (!pending || !aiRetryAllowed(review!, now)) return { go: false, drop: true } as const;

    const previous = (review!.sentimentAttempt ?? null) as Attempt;
    const failures = previous?.basisHash === p.basis && typeof previous.failures === "number" ? previous.failures + 1 : 1;
    tx.set(leaseRef, { until: now + SENTIMENT_LEASE_TTL_MS }, { merge: true });
    tx.set(usageRef, { day, calls: calls + 1 }, { merge: true });
    tx.update(reviewRef, { sentimentAttempt: { basisHash: p.basis, failures, lastAt: new Date(now) } });
    return { go: true, failures } as const;
  });
}

/**
 * After a labelled call: write the label (clearing the strike) if the review
 * still has the content it was classified from — or was tombstoned during the
 * call (no content left to compare; readers hide tombstones, and a review
 * restored unchanged then needs no second call). Returns whether it wrote.
 */
export async function finishCall(sa: string, p: CallItem, label: SentimentLabel, model: string, at: Date): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`${reviewsCollection(sa)}/${p.docId}`);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as ReviewData | undefined;
    const same = d?.state === "active" && reviewBasis(d) === p.basis;
    if (!same && d?.state !== "removed") return false;
    tx.update(ref, { sentiment: { label, method: "ai", basisHash: p.basis, model, at }, sentimentAttempt: null });
    return true;
  });
}

/** A failed CALL is not a strike: take back the +1 beginCall wrote (only if it is still ours); `lastAt` stays. */
export async function uncountStrike(sa: string, p: CallItem, failures: number): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`${reviewsCollection(sa)}/${p.docId}`);
  await db.runTransaction(async (tx) => {
    const a = ((await tx.get(ref)).data() as ReviewData | undefined)?.sentimentAttempt;
    if (a?.basisHash === p.basis && a.failures === failures) tx.update(ref, { "sentimentAttempt.failures": failures - 1 });
  });
}

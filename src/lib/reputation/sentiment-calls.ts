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
 *   finishCall  AFTER it: a label clears the strike. A failed call keeps it
 *               — every failure is a strike, and the run stops on the first.
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
  /** The AI call failed (any way) or the provider could not be obtained. */
  | "ai_error";

export interface CallItem {
  docId: string;
  basis: string;
}
type ReviewData = SentimentSource & { state?: string };
export type Attempt = { basisHash?: unknown; failures?: unknown; lastAt?: unknown } | null;
export type BeginResult = { go: true } | { go: false; stop: StopReason } | { go: false; drop: true };

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
    return { go: true } as const;
  });
}

/**
 * After a labelled call: write the label (clearing the strike) only if the
 * review still has the content it was classified from. Returns whether it did.
 */
export async function finishCall(sa: string, p: CallItem, label: SentimentLabel, model: string, at: Date): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`${reviewsCollection(sa)}/${p.docId}`);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as ReviewData | undefined;
    if (d?.state !== "active" || reviewBasis(d) !== p.basis) return false;
    tx.update(ref, { sentiment: { label, method: "ai", basisHash: p.basis, model, at }, sentimentAttempt: null });
    return true;
  });
}

import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";
import { reviewsAiConfigured } from "./ai/mode";
import { getReviewsAiFor } from "./ai/select";
import type { ReviewsAi, SentimentLabel } from "./ai/types";

/**
 * Review sentiment (SP5 b): `sentiment {label, method, basisHash, model, at}`
 * cached on each `gbpReviews` doc.
 *
 *   - Eligible: the reviews inbox's own set (`loadServedReviews` — active,
 *     current listing, within Google's 30-day limit) with no label, or one
 *     whose `basisHash` no longer matches `sentimentBasis(stars, comment)`.
 *   - Star-only (no / blank comment): labelled from the stars, no AI call.
 *   - With text: one AI item each, in batches of 20, only when Reviews AI is
 *     configured; the reply is validated per item (ai/openrouter.ts).
 *   - NEVER RE-BILLED: an unchanged review is never sent twice — the basis
 *     check skips it, and one lease per sub-account (`private/sentimentLease`)
 *     keeps two invocations from both sending it. Each label is written in a
 *     transaction that re-reads the review and writes only if it is still
 *     active with the same basis (edited mid-flight ⇒ discarded).
 *   - At most `max` (default 100) reviews per run, newest first; the rest wait
 *     for the next run.
 */

export const SENTIMENT_MAX_PER_RUN = 100;
export const SENTIMENT_LEASE_TTL_MS = 5 * 60_000;
const AI_BATCH = 20;

export type SentimentMethod = "rating" | "ai";
export interface SentimentDoc {
  label: SentimentLabel;
  method: SentimentMethod;
  basisHash: string;
  model: string | null;
  at: Date;
}

export interface SentimentCounts {
  /** Labels written this run. */
  classified: number;
  /** Eligible but not attempted (over the cap, AI not configured, lease lost) or discarded (edited mid-flight). */
  skipped: number;
  /** Sent for classification but not labelled (bad model output, failed call, refused provider). */
  failed: number;
}
export type SentimentSkip = "gate_off" | "google_gate_off" | "no_listing" | "busy";
export interface SentimentOutcome extends SentimentCounts {
  status: "ran" | "skipped";
  skipReason: SentimentSkip | null;
  /** False when no AI can be called here (text reviews wait). */
  aiConfigured: boolean;
}

export const sentimentLeasePath = (subAccountId: string) => `subAccounts/${subAccountId}/private/sentimentLease`;

/** What a label was derived from: the stars and the exact comment. */
export function sentimentBasis(starRating: number | null, comment: string | null): string {
  return createHash("sha256").update(`${starRating ?? ""}\n${comment ?? ""}`).digest("hex");
}

export function ratingLabel(stars: number): SentimentLabel {
  return stars >= 4 ? "positive" : stars === 3 ? "neutral" : "negative";
}

const isStarOnly = (comment: unknown) => typeof comment !== "string" || comment.trim() === "";

interface Pending {
  docId: string;
  starRating: number;
  comment: string | null;
  basis: string;
}

async function takeLease(sa: string, runId: string, now: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(sentimentLeasePath(sa));
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() as { runId?: string; until?: number } | undefined;
    if (cur?.runId && cur.runId !== runId && (cur.until ?? 0) > now) return false;
    tx.set(ref, { runId, until: now + SENTIMENT_LEASE_TTL_MS }, { merge: true });
    return true;
  });
}

async function releaseLease(sa: string, runId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(sentimentLeasePath(sa));
  try {
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() as { runId?: string } | undefined;
      if (cur?.runId === runId) tx.set(ref, { runId: null, until: 0 }, { merge: true });
    });
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${sa} lease not released kind=${err instanceof Error ? err.name : typeof err}`);
  }
}

export const SENTIMENT_MANUAL_COOLDOWN_MS = 60_000;

/** "Analyse now" at most once a minute per sub-account; true = this press may run. */
export async function claimSentimentManualSlot(subAccountId: string, now: Date): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(sentimentLeasePath(subAccountId));
  return db.runTransaction(async (tx) => {
    const last = ((await tx.get(ref)).data()?.lastManualAt as number | undefined) ?? null;
    if (last !== null && now.getTime() - last < SENTIMENT_MANUAL_COOLDOWN_MS) return false;
    tx.set(ref, { lastManualAt: now.getTime() }, { merge: true });
    return true;
  });
}

/** Write one label iff the review is still active with the basis it was classified from. */
async function writeLabel(sa: string, p: Pending, label: SentimentLabel, method: SentimentMethod, model: string | null, now: Date) {
  const db = getAdminDb();
  const ref = db.doc(`${reviewsCollection(sa)}/${p.docId}`);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as { state?: string; starRating?: number | null; comment?: string | null } | undefined;
    if (d?.state !== "active" || sentimentBasis(d.starRating ?? null, d.comment ?? null) !== p.basis) return false;
    const sentiment: SentimentDoc = { label, method, basisHash: p.basis, model, at: now };
    tx.update(ref, { sentiment });
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
  for (let i = 0; i < text.length; i += AI_BATCH) {
    const batch = text.slice(i, i + AI_BATCH);
    // Renew before each billed call; a lost lease means another run owns this tenant now.
    if (!(await takeLease(sa, runId, Date.now()))) {
      counts.skipped += text.length - i;
      return;
    }
    const labels = new Map(
      (await ai.classifySentiment(batch.map((p) => ({ id: p.docId, starRating: p.starRating, text: p.comment ?? "" })))).map(
        (r) => [r.id, r.label],
      ),
    );
    for (const p of batch) {
      const label = labels.get(p.docId);
      if (!label) counts.failed++;
      else if (await writeLabel(sa, p, label, "ai", ai.model, now)) counts.classified++;
      else counts.skipped++;
    }
  }
}

export async function classifyPendingSentiment(
  subAccountId: string,
  opts: { max?: number; now?: Date } = {},
): Promise<SentimentOutcome> {
  const now = opts.now ?? new Date();
  const counts: SentimentCounts = { classified: 0, skipped: 0, failed: 0 };
  const aiConfigured = reviewsAiConfigured();
  const skip = (skipReason: SentimentSkip): SentimentOutcome => ({ status: "skipped", skipReason, aiConfigured, ...counts });

  const db = getAdminDb();
  const sub = ((await db.doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubAccountDoc;
  if (sub.reviewsAiEnabledByAgency !== true) return skip("gate_off");
  if (sub.googleEnabledByAgency !== true) return skip("google_gate_off");
  const locationName = sub.googleListing?.locationName ?? null;
  if (!locationName) return skip("no_listing");

  const runId = randomUUID();
  if (!(await takeLease(subAccountId, runId, now.getTime()))) return skip("busy");
  try {
    const { reviews } = await loadServedReviews(subAccountId, locationName, now);
    const pending: Pending[] = reviews.flatMap((r) => {
      const starRating = typeof r.starRating === "number" ? r.starRating : null;
      if (starRating === null) return [];
      const comment = typeof r.comment === "string" ? r.comment : null;
      const basis = sentimentBasis(starRating, comment);
      const current = r.sentiment as { basisHash?: string } | null | undefined;
      return current?.basisHash === basis ? [] : [{ docId: String(r.docId), starRating, comment, basis }];
    });
    const max = opts.max ?? SENTIMENT_MAX_PER_RUN;
    counts.skipped += Math.max(0, pending.length - max);
    const batch = pending.slice(0, max);

    for (const p of batch.filter((x) => isStarOnly(x.comment))) {
      if (await writeLabel(subAccountId, p, ratingLabel(p.starRating), "rating", null, now)) counts.classified++;
      else counts.skipped++;
    }
    const text = batch.filter((x) => !isStarOnly(x.comment));
    if (!aiConfigured) counts.skipped += text.length;
    else if (text.length) await classifyText(subAccountId, runId, text, counts, now);
  } finally {
    await releaseLease(subAccountId, runId);
  }
  return { status: "ran", skipReason: null, aiConfigured, ...counts };
}

/**
 * After a sync that landed pages: classify, best effort — a failure here is
 * logged by kind and reported as counts, never thrown into the sync.
 * Null when the run did not classify (gates, no listing, another run busy).
 */
export async function sentimentAfterSync(subAccountId: string): Promise<SentimentCounts | null> {
  try {
    const out = await classifyPendingSentiment(subAccountId);
    return out.status === "ran" ? { classified: out.classified, skipped: out.skipped, failed: out.failed } : null;
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${subAccountId} after-sync failed kind=${err instanceof Error ? err.name : typeof err}`);
    return null;
  }
}

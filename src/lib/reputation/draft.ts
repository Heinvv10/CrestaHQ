import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import type { DraftInput } from "./ai/types";
import { DAILY_AI_CALL_CAP, sentimentUsagePath } from "./sentiment-calls";

/**
 * Reply drafts (SP5 c) — the bookkeeping around ONE draft call. A draft only
 * ever fills the admin's reply box: nothing here (or in the draft route)
 * reaches the provider's putReply / deleteReply — lib/gbp/reply.ts stays the
 * only poster, on the admin's click. No draft text is stored or logged.
 *
 *   - Rate: 10 drafts a minute per user and sub-account, in memory, per
 *     instance — an abuse dampener, like the other in-memory limiters.
 *   - Spend: every draft counts against the SAME daily AI call cap as
 *     sentiment (`private/sentimentUsage {day, calls}`, DAILY_AI_CALL_CAP),
 *     and drafts alone may use at most DRAFT_DAILY_CAP of it
 *     (`{draftsDay, draftCalls}` in the same doc — its own day, because
 *     sentiment rewrites `day`), so sentiment always keeps ≥ 200 calls a day;
 *     counted in one transaction with a re-check of both gates BEFORE the
 *     call; over the cap there is no call. No strikes and no refunds: a
 *     draft is one human click, one call, and it counts whether or not the
 *     model then produced a usable draft.
 */

export const DRAFTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const MAX_TRACKED = 5_000;
const hits = new Map<string, number[]>();

/** Tests only: each test starts with an empty limiter. */
export function resetDraftLimiter(): void {
  hits.clear();
}

export function checkDraftRate(subAccountId: string, uid: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
  if (hits.size > MAX_TRACKED) {
    for (const [k, times] of hits) if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  const key = `${subAccountId}|${uid}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= DRAFTS_PER_MINUTE) {
    hits.set(key, recent);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true };
}

/** Drafts' share of DAILY_AI_CALL_CAP per sub-account per UTC day — the rest stays sentiment's. */
export const DRAFT_DAILY_CAP = 100;

export type DraftStop = "gate_off" | "ai_gate_off" | "daily_cap" | "draft_cap";

/** Re-check both gates and the daily cap, and count this call — one transaction, before the call. */
export async function beginDraftCall(subAccountId: string): Promise<DraftStop | null> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const usageRef = db.doc(sentimentUsagePath(subAccountId));
  return db.runTransaction(async (tx) => {
    const sub = (await tx.get(subRef)).data() as { googleEnabledByAgency?: boolean; reviewsAiEnabledByAgency?: boolean } | undefined;
    const usage = (await tx.get(usageRef)).data() as
      | { day?: string; calls?: number; draftsDay?: string; draftCalls?: number }
      | undefined;
    if (sub?.googleEnabledByAgency !== true) return "gate_off";
    if (sub.reviewsAiEnabledByAgency !== true) return "ai_gate_off";
    const day = new Date().toISOString().slice(0, 10);
    const calls = usage?.day === day ? (usage.calls ?? 0) : 0;
    if (calls >= DAILY_AI_CALL_CAP) return "daily_cap";
    const draftCalls = usage?.draftsDay === day ? (usage.draftCalls ?? 0) : 0;
    if (draftCalls >= DRAFT_DAILY_CAP) return "draft_cap";
    tx.set(usageRef, { day, calls: calls + 1, draftsDay: day, draftCalls: draftCalls + 1 }, { merge: true });
    return null;
  });
}

/** What the model is given for one cached review — built server-side, never from the request. */
export async function draftInputFor(subAccountId: string, docId: string): Promise<DraftInput> {
  const db = getAdminDb();
  const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data() ?? {};
  const review = (await db.doc(`${reviewsCollection(subAccountId)}/${docId}`).get()).data() ?? {};
  const reviewer = (review.reviewer ?? {}) as { displayName?: unknown; isAnonymous?: unknown };
  const name = typeof reviewer.displayName === "string" && reviewer.isAnonymous !== true ? reviewer.displayName.trim() : "";
  const guidelines = (sub.reviewsAiConfig as { replyGuidelines?: unknown } | null | undefined)?.replyGuidelines;
  return {
    starRating: Number(review.starRating),
    comment: typeof review.comment === "string" ? review.comment : null,
    reviewerFirstName: name ? name.split(/\s+/)[0] : null,
    businessName: String(sub.googleListing?.title || sub.name || "our business"),
    guidelines: typeof guidelines === "string" && guidelines.trim() ? guidelines : null,
  };
}

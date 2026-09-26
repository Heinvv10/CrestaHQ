import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { autoReplyNeverCollection, stableReviewKey } from "@/lib/gbp/auto-reply-never";
import { PENDING_MS } from "@/lib/gbp/reply-attempts";
import { reviewsCollection, toMillis } from "@/lib/gbp/sync/types";
import { reviewsAiConfigured } from "../ai/mode";
import { getReviewsAiFor } from "../ai/select";
import type { ReviewsAi } from "../ai/types";
import { beginDraftCall, draftInputFor } from "../draft";
import { reviewBasis } from "../sentiment-basis";
import { sentimentUsagePath } from "../sentiment-calls";
import { decide, type DecideCounts, type DecideReview, type DecideSettings, type Decision } from "./decide";
import { autoReplyKillSwitchOn } from "./kill-switch";
import { postQueued } from "./post";
import { AUTO_REPLY_DAILY_DRAFT_CAP, readAutoReplySettings } from "./settings";
import {
  acquireAutoReplyLease, autoDraftsToday, autoReplyDismissedCollection, holdQueuedForApproval, postsToday, readPending,
  releaseAutoReplyLease, renewAutoReplyLease, storePending, toDecidePending,
} from "./store";

/**
 * The review auto-reply engine (AUTO_REPLY_V1_PLAN.md) — one sub-account,
 * after a sync, never inside it. Inert unless the deployment's kill switch
 * is set (no read at all otherwise). Then: the three gates, auto-reply on,
 * the listing it was enabled for, Reviews AI configured; one run per
 * sub-account (lease); every review decided (decide.ts) newest first; each
 * draft stored on the review BEFORE any post (so a retry posts the same
 * bytes); each post through post.ts. The deadline is checked before every
 * draft and every post. Never throws: a failure is logged by kind and the
 * next sync's run carries on from the stored state.
 */

export interface AutoReplyRun {
  drafted: number;
  posted: number;
  held: number;
  stop: string | null;
}

const kind = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export async function autoReplyAfterSync(sa: string, runStartedAt: Date, deadline: number): Promise<AutoReplyRun | null> {
  if (!autoReplyKillSwitchOn()) return null;
  try {
    return await runEngine(sa, runStartedAt.getTime(), deadline);
  } catch (err) {
    console.warn(`[reputation/auto-reply] sa=${sa} run failed kind=${kind(err)}`);
    return null;
  }
}

interface Ctx {
  sa: string;
  runId: string;
  runStartedAt: number;
  deadline: number;
  settings: DecideSettings;
  enabledByUid: string;
  counts: DecideCounts;
  ai: ReviewsAi;
  tally: AutoReplyRun;
}

async function runEngine(sa: string, runStartedAt: number, deadline: number): Promise<AutoReplyRun> {
  const tally: AutoReplyRun = { drafted: 0, posted: 0, held: 0, stop: null };
  const db = getAdminDb();
  const sub = (await db.doc(`subAccounts/${sa}`).get()).data() ?? {};
  const gatesOn = sub.googleEnabledByAgency === true && sub.reviewsAiEnabledByAgency === true
    && sub.reviewsAutoReplyEnabledByAgency === true;
  const raw = (sub.reviewsAutoReply ?? {}) as { enabledAt?: unknown; enabledByUid?: unknown; listingLocationName?: unknown };
  const stored = readAutoReplySettings(raw);
  const listing = sub.googleListing?.locationName;
  if (!gatesOn || !stored.enabled) return { ...tally, stop: "off" };
  if (typeof listing !== "string" || raw.listingLocationName !== listing) return { ...tally, stop: "listing_changed" };
  if (typeof raw.enabledByUid !== "string" || !reviewsAiConfigured()) return { ...tally, stop: "not_configured" };

  const runId = randomUUID();
  if (!(await acquireAutoReplyLease(sa, runId, Date.now()))) return { ...tally, stop: "busy" };
  try {
    const now = Date.now();
    const ctx: Ctx = {
      sa, runId, runStartedAt, deadline, tally, enabledByUid: raw.enabledByUid,
      settings: { ...stored, enabledAtMs: toMillis(raw.enabledAt), listingLocationName: listing },
      counts: { postsToday: await postsToday(sa, now), autoDraftsToday: await autoDraftsToday(sentimentUsagePath(sa), now) },
      ai: await getReviewsAiFor(sa),
    };
    const dismissed = new Map<string, unknown>();
    for (const d of (await db.collection(autoReplyDismissedCollection(sa)).get()).docs) dismissed.set(d.id, d.data().basisHash);
    const never = new Set((await db.collection(autoReplyNeverCollection(sa)).get()).docs.map((d) => d.id));
    const docs = (await db.collection(reviewsCollection(sa)).get()).docs
      .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
      .sort((a, b) => (toMillis(b.data.createTime) ?? 0) - (toMillis(a.data.createTime) ?? 0));
    for (const { id, data } of docs) {
      const key = stableReviewKey(String(data.reviewName ?? ""));
      const review = decideInput(data, dismissed.get(key), never.has(key), Date.now());
      const decision = decide(review, ctx.settings, { now: Date.now(), runStartedAt }, ctx.counts);
      tally.stop = await act(ctx, id, data, review, decision);
      if (tally.stop) break;
    }
  } finally {
    await releaseAutoReplyLease(sa, runId);
  }
  return tally;
}

function decideInput(d: Record<string, unknown>, dismissedBasis: unknown, never: boolean, now: number): DecideReview {
  const lock = d.replyInFlight as { at?: unknown } | null | undefined;
  return {
    state: String(d.state ?? ""),
    locationName: String(d.locationName ?? ""),
    starRating: typeof d.starRating === "number" ? d.starRating : null,
    comment: typeof d.comment === "string" ? d.comment : null,
    createTimeMs: toMillis(d.createTime),
    lastSeenAtMs: toMillis(d.lastSeenAt),
    hasReply: !!d.reply,
    hadReply: d.hadReply === true,
    never,
    inFlight: !!lock && now - (toMillis(lock.at) ?? 0) < PENDING_MS,
    autoReplied: !!d.autoReplied,
    basisHash: d.state === "active" ? reviewBasis(d) : null,
    pending: toDecidePending(readPending(d.pendingReply)),
    dismissedBasisHash: typeof dismissedBasis === "string" ? dismissedBasis : null,
  };
}

/** One review's decision carried out; a non-null result stops the run. */
async function act(ctx: Ctx, docId: string, data: Record<string, unknown>, review: DecideReview, d: Decision): Promise<string | null> {
  if (d.verdict === "skip") return null;
  if (d.verdict === "to_approval") {
    const p = readPending(data.pendingReply);
    if (p?.textHash) await holdQueuedForApproval(ctx.sa, docId, p.textHash);
    ctx.tally.held += 1;
    return null;
  }
  const basisHash = review.basisHash!;
  if (d.verdict === "hold" && !d.draft) {
    const p = review.pending;
    if (!(p?.reason === d.reason && p.basisHash === basisHash)) {
      await storePending(ctx.sa, docId, { text: null, basisHash, reason: d.reason, model: null }, new Date());
    }
    ctx.tally.held += 1;
    return null;
  }
  let text = d.verdict === "auto" && d.stored ? readPending(data.pendingReply)?.text ?? null : null;
  if (text === null) {
    const drafted = await draft(ctx, docId, basisHash, d.verdict === "auto" ? "auto_queued" : d.reason);
    if (drafted !== null && typeof drafted === "object") return drafted.stop;
    if (drafted === null || d.verdict !== "auto") return null;
    text = drafted;
  }
  const reviewName = String(data.reviewName ?? "");
  const result = await postQueued(ctx.sa, { runId: ctx.runId, docId, reviewName, text, enabledByUid: ctx.enabledByUid, deadline: ctx.deadline });
  if (result === "posted") {
    ctx.tally.posted += 1;
    ctx.counts.postsToday += 1;
  }
  return result === "stop" ? "post_stopped" : null;
}

/**
 * Draft one review and store it as `reason`. The stored text when it was
 * stored; `{stop}` to end the run; null when this review is done for now
 * (held for lack of budget, draft failed, or changed during the call).
 */
async function draft(
  ctx: Ctx, docId: string, basisHash: string,
  reason: "auto_queued" | "approval" | "texted",
): Promise<string | { stop: string } | null> {
  if (Date.now() >= ctx.deadline) return { stop: "deadline" };
  if (!(await renewAutoReplyLease(ctx.sa, ctx.runId, Date.now()))) return { stop: "lease_lost" };
  const stop = await beginDraftCall(ctx.sa, { auto: true });
  if (stop === "gate_off" || stop === "ai_gate_off") return { stop };
  if (stop) {
    ctx.counts.autoDraftsToday = AUTO_REPLY_DAILY_DRAFT_CAP;
    await storePending(ctx.sa, docId, { text: null, basisHash, reason: "no_budget", model: null }, new Date());
    ctx.tally.held += 1;
    return null;
  }
  ctx.counts.autoDraftsToday += 1;
  // No reviewer name on the auto path: a display name is untrusted text a
  // member of the public chose, and this draft may be posted unread.
  const input = { ...(await draftInputFor(ctx.sa, docId)), reviewerFirstName: null };
  const result = await ctx.ai.draftReply(input);
  if (result.text === null) {
    console.warn(`[reputation/auto-reply] no draft sa=${ctx.sa} failure=${result.failure}`);
    await storePending(ctx.sa, docId, { text: null, basisHash, reason: "draft_failed", model: ctx.ai.model }, new Date());
    return null;
  }
  const stored = await storePending(ctx.sa, docId, { text: result.text, basisHash, reason, model: ctx.ai.model }, new Date());
  if (!stored) return null;
  ctx.tally.drafted += 1;
  if (reason !== "auto_queued") ctx.tally.held += 1;
  return result.text;
}

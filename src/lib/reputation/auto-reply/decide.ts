import type { AutoReplyMode, AutoReplyStar } from "@/types";
import { AUTO_REPLY_DAILY_DRAFT_CAP, AUTO_REPLY_DAILY_POST_CAP } from "./settings";

/**
 * What the auto-reply engine does with ONE cached review (AUTO_REPLY_V1_PLAN.md
 * "Engine" + the `pendingReply` state table). Pure: the caller (run.ts) reads
 * Firestore, computes the review's basis hash and whether a reply is in
 * flight, and passes plain values in.
 *
 *   skip   nothing to do (and nothing is written)
 *   hold   a person must post it: drafted and held (`approval` / `texted`),
 *          or held WITHOUT a draft because a daily cap is spent
 *          (`no_budget` = the 40 auto drafts, `cap` = the 20 auto posts)
 *   auto   post automatically — the stored draft (`stored`) or a new one
 *   to_approval  a queued draft whose review is no longer eligible because
 *          auto-reply was switched off and on (backlog off): kept, now held
 *          for a person (plan step 4b)
 *
 * Only a rating-only review (blank or whitespace comment) of a star set to
 * Auto is ever `auto`: any written text is held, whatever the star's mode.
 */

export type PendingReason =
  | "auto_queued" | "approval" | "texted" | "draft_failed" | "post_failed" | "no_budget" | "cap" | "dismissed";
export const PENDING_REASONS: readonly PendingReason[] = [
  "auto_queued", "approval", "texted", "draft_failed", "post_failed", "no_budget", "cap", "dismissed",
];

/** A failed draft, or a post Google refused for this review, is retried once a day. */
export const DRAFT_RETRY_MS = 24 * 3600_000;

export interface DecidePending {
  reason: PendingReason;
  basisHash: string | null;
  atMs: number | null;
  hasText: boolean;
}

export interface DecideReview {
  state: string;
  locationName: string;
  starRating: number | null;
  comment: string | null;
  createTimeMs: number | null;
  lastSeenAtMs: number | null;
  hasReply: boolean;
  /** Sticky: the review had a reply at some point — never auto-replied, even after a deletion. */
  hadReply: boolean;
  /** Another key's reply post holds the review's live in-flight lock. */
  inFlight: boolean;
  autoReplied: boolean;
  /** The review's current basis (stars + comment); null without a rating. */
  basisHash: string | null;
  pending: DecidePending | null;
  /** `autoReplyDismissed/{reviewDocId}.basisHash` — a Discard that survives a cache clear. */
  dismissedBasisHash: string | null;
}

export interface DecideSettings {
  enabled: boolean;
  modes: Record<AutoReplyStar, AutoReplyMode>;
  includeBacklog: boolean;
  enabledAtMs: number | null;
  listingLocationName: string | null;
}

export interface DecideCounts {
  /** Auto posts counted today (SAST day). */
  postsToday: number;
  /** Auto drafts counted today (the drafts' UTC day). */
  autoDraftsToday: number;
}

export type SkipWhy =
  | "disabled" | "tombstoned" | "other_listing" | "replied" | "in_flight" | "auto_replied" | "not_seen"
  | "no_rating" | "before_enabled" | "dismissed" | "held" | "draft_retry_wait" | "cap_wait" | "had_reply"
  | "post_retry_wait";

export type Decision =
  | { verdict: "skip"; why: SkipWhy }
  | { verdict: "hold"; reason: "approval" | "texted"; draft: true }
  | { verdict: "hold"; reason: "no_budget" | "cap"; draft: false }
  | { verdict: "auto"; stored: boolean }
  | { verdict: "to_approval" };

const skip = (why: SkipWhy): Decision => ({ verdict: "skip", why });

export const isTexted = (comment: string | null) => typeof comment === "string" && comment.trim() !== "";

const isStar = (n: number | null): n is AutoReplyStar => n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
const queued = (p: DecidePending) => (p.reason === "auto_queued" || p.reason === "post_failed") && p.hasText;

function held(reason: "approval" | "texted", counts: DecideCounts): Decision {
  if (counts.autoDraftsToday >= AUTO_REPLY_DAILY_DRAFT_CAP) return { verdict: "hold", reason: "no_budget", draft: false };
  return { verdict: "hold", reason, draft: true };
}

export function decide(
  r: DecideReview,
  settings: DecideSettings,
  ctx: { now: number; runStartedAt: number },
  counts: DecideCounts,
): Decision {
  if (!settings.enabled) return skip("disabled");
  if (r.state !== "active") return skip("tombstoned");
  if (!settings.listingLocationName || r.locationName !== settings.listingLocationName) return skip("other_listing");
  if (r.hasReply) return skip("replied");
  if (r.hadReply) return skip("had_reply");
  if (r.inFlight) return skip("in_flight");
  if (r.autoReplied) return skip("auto_replied");
  // Stale cache never posts: only a review the run that just finished saw.
  if (r.lastSeenAtMs === null || r.lastSeenAtMs < ctx.runStartedAt) return skip("not_seen");
  if (!isStar(r.starRating) || r.basisHash === null) return skip("no_rating");
  const p = r.pending;
  const fresh = p !== null && p.basisHash === r.basisHash;
  if (!settings.includeBacklog) {
    if (settings.enabledAtMs === null || r.createTimeMs === null || r.createTimeMs < settings.enabledAtMs) {
      // Queued before auto-reply was switched off and on: kept, now waits for a person.
      return p && fresh && queued(p) ? { verdict: "to_approval" } : skip("before_enabled");
    }
  }
  if (r.dismissedBasisHash !== null && r.dismissedBasisHash === r.basisHash) return skip("dismissed");

  if (p && fresh) {
    if (p.reason === "dismissed") return skip("dismissed");
    if (p.reason === "approval" || p.reason === "texted") return skip("held");
    if (p.reason === "auto_queued" && p.hasText) {
      return counts.postsToday >= AUTO_REPLY_DAILY_POST_CAP ? skip("cap_wait") : { verdict: "auto", stored: true };
    }
    if (p.reason === "draft_failed" && (p.atMs === null || ctx.now - p.atMs < DRAFT_RETRY_MS)) {
      return skip("draft_retry_wait");
    }
    if (p.reason === "post_failed" && p.hasText) {
      if (p.atMs === null || ctx.now - p.atMs < DRAFT_RETRY_MS) return skip("post_retry_wait");
      return counts.postsToday >= AUTO_REPLY_DAILY_POST_CAP ? skip("cap_wait") : { verdict: "auto", stored: true };
    }
  }
  const mode = settings.modes[r.starRating];
  // A held draft whose review changed is re-drafted and stays held, its reason re-derived.
  if (p && !fresh && (p.reason === "approval" || p.reason === "texted")) {
    return held(mode === "auto" && isTexted(r.comment) ? "texted" : "approval", counts);
  }

  if (mode !== "auto") return held("approval", counts);
  if (isTexted(r.comment)) return held("texted", counts);
  if (counts.postsToday >= AUTO_REPLY_DAILY_POST_CAP) return { verdict: "hold", reason: "cap", draft: false };
  if (counts.autoDraftsToday >= AUTO_REPLY_DAILY_DRAFT_CAP) return { verdict: "hold", reason: "no_budget", draft: false };
  return { verdict: "auto", stored: false };
}

import "server-only";

import { reviewBasis } from "../sentiment-basis";
import { PENDING_REASONS, type PendingReason } from "./decide";

/**
 * What the Reviews tab may show of an auto-reply draft (AUTO_REPLY_V1_PLAN.md,
 * UI): the "Needs approval" filter, each row's reason and the composer's
 * pre-fill. Only the reason and the draft TEXT leave the server — never the
 * textHash, basisHash, model or time.
 */

/** The row's reason, as the page labels it. */
export type ApprovalState = "held" | "queued" | "paused" | "draft_failed" | "over_limit" | "post_failed";

export interface PublicApproval {
  state: ApprovalState;
  /** The stored draft, for the composer's pre-fill; null when there is none. */
  draft: string | null;
}

type ReviewData = Record<string, unknown>;

/**
 * The review's auto-reply draft a person may act on, or null. All four hold:
 * a `pendingReply` is present, it is FRESH (its basisHash is the review's
 * current basis — an edited review's draft is stale), it is not a Discard,
 * and the review has no reply.
 */
function heldPending(d: ReviewData): { reason: Exclude<PendingReason, "dismissed">; text: string | null } | null {
  const p = d.pendingReply as { reason?: unknown; basisHash?: unknown; text?: unknown } | null | undefined;
  if (!p || !PENDING_REASONS.includes(p.reason as PendingReason)) return null;
  if (p.reason === "dismissed") return null;
  if (d.reply) return null;
  const basis = reviewBasis(d);
  if (basis === null || p.basisHash !== basis) return null;
  return { reason: p.reason as Exclude<PendingReason, "dismissed">, text: typeof p.text === "string" ? p.text : null };
}

export const needsApproval = (d: ReviewData): boolean => heldPending(d) !== null;

/**
 * `autoPosts`: whether the engine would post this review's star right now
 * (kill switch, gates, auto-reply on for this listing, the star on Auto) — a
 * queued draft that it would not post is shown as paused.
 */
export function publicApproval(d: ReviewData, autoPosts: (star: number) => boolean): PublicApproval | null {
  const held = heldPending(d);
  if (!held) return null;
  const state: ApprovalState =
    held.reason === "auto_queued" ? (autoPosts(Number(d.starRating)) ? "queued" : "paused")
    : held.reason === "approval" || held.reason === "texted" ? "held"
    : held.reason === "no_budget" || held.reason === "cap" ? "over_limit"
    : held.reason;
  return { state, draft: held.text };
}

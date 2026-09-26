import "server-only";

import { readAutoReplySettings } from "@/lib/reputation/auto-reply/settings";

/**
 * The auto-reply engine's guard INSIDE the reply claim's transaction
 * (claimAttempt `requireNoReply`, AUTO_REPLY_V1_PLAN.md) — the last moment
 * before Google is called, after the engine's own final re-check:
 *
 *   already_replied  the review has, or ever had, a reply (any author) —
 *                    an owner who deleted one chose "no reply"
 *   not_queued       its draft is no longer these queued bytes (a Discard
 *                    or an edit landed), or its star is no longer Auto
 */

type Tx = FirebaseFirestore.Transaction;
type Data = Record<string, unknown>;

export const QUEUED_REASONS = ["auto_queued", "post_failed"];

export const everReplied = (review: Data) => !!review.reply || review.hadReply === true;

export async function autoClaimRefusal(
  tx: Tx,
  subRef: FirebaseFirestore.DocumentReference,
  review: Data,
  textHash: string,
): Promise<"already_replied" | "not_queued" | null> {
  const sub = (await tx.get(subRef)).data() ?? {};
  if (everReplied(review)) return "already_replied";
  const pending = review.pendingReply as { reason?: unknown; textHash?: unknown } | null | undefined;
  if (!pending || !QUEUED_REASONS.includes(String(pending.reason)) || pending.textHash !== textHash) return "not_queued";
  const star = review.starRating as 1 | 2 | 3 | 4 | 5;
  if (readAutoReplySettings(sub.reviewsAutoReply).modes[star] !== "auto") return "not_queued";
  return null;
}

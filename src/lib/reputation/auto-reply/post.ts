import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { recordAuditEvent } from "@/lib/audit/record";
import { loadReplyTarget, postReply, replyPreflight } from "@/lib/gbp/reply";
import { attemptSucceeded } from "@/lib/gbp/reply-attempts";
import { confirmAutoPost } from "./confirm";
import { autoReplyKey, finalizeAutoPost, markPostFailed, textHashOf } from "./store";

/**
 * Post ONE stored `auto_queued` (or `post_failed`, once a day) draft — exactly
 * its stored bytes, under the key `auto:{reviewDocId}:{textHash}`, so a retry
 * after a failed post is the same attempt and can never post two different
 * texts (AUTO_REPLY_V1_PLAN.md step 4). In order: the run's deadline; an
 * attempt Google already accepted is only recorded (finalizeAutoPost — never
 * counted, posted or audited again); the reply route's own review lookup and
 * preflight; the final re-check transaction (confirm.ts); then `postReply`
 * with `requireNoReply` (no reply ever, the same queued bytes, still Auto).
 *
 *   posted   Google accepted it; `autoReplied` stamped, audited once
 *   held     the star was switched to Approval meanwhile: the draft now waits for a person
 *   skipped  this review is not posted now (gone, changed, replied, held,
 *            or Google refused THIS review — `post_failed`, retried in 24 h)
 *   stop     nothing more should post in this run (deadline, pause, cap,
 *            lease, auth, rate limit, a Google outage) — the draft stays queued
 */

export const AUTO_REPLY_ACTOR = "system:auto-reply";

export type PostResult = "posted" | "held" | "skipped" | "stop";

/** Refusals about this one review (a 404 from Google, a 4xx rejecting the request); anything else stops the run. */
const PER_REVIEW_CODES = new Set(["not_found", "malformed", "idempotency_key_reused"]);

const kind = (err: unknown) => (err instanceof Error ? err.name : typeof err);

async function audit(sa: string, docId: string, agencyId: string, enabledByUid: string): Promise<void> {
  try {
    await recordAuditEvent(getAdminDb(), {
      action: "review.auto_replied",
      actor: { type: "system", id: "auto-reply" },
      target: { type: "review", id: docId },
      agencyId,
      subAccountId: sa,
      changes: [],
      onBehalfOfUid: enabledByUid,
    });
  } catch (err) {
    // The reply is public already; the gbpEvents row (written with it) stands.
    console.error(`[reputation/auto-reply] audit event not recorded sa=${sa}: ${kind(err)}`);
  }
}

export async function postQueued(
  sa: string,
  q: { runId: string; docId: string; reviewName: string; text: string; enabledByUid: string; deadline: number },
): Promise<PostResult> {
  if (Date.now() >= q.deadline) return "stop";
  const textHash = textHashOf(q.text);
  const key = autoReplyKey(q.docId, textHash);
  if (await attemptSucceeded(sa, key)) {
    await finalizeAutoPost(sa, q.docId, q.reviewName, key, q.enabledByUid, new Date());
    return "skipped";
  }
  const target = await loadReplyTarget(sa, q.docId);
  if (!target) return "skipped";
  if (await replyPreflight(sa)) return "stop";

  const confirmed = await confirmAutoPost(sa, { runId: q.runId, docId: q.docId, textHash }, Date.now());
  if (confirmed === "approval") return "held";
  if (confirmed === "stale" || confirmed === "listing_paused") return "skipped";
  if (confirmed !== "go") return "stop";

  const res = await postReply(
    sa, target, { comment: q.text, idempotencyKey: key }, AUTO_REPLY_ACTOR,
    { createdByUid: q.enabledByUid, textHash },
  );
  const body = (await res.json()) as { reply?: unknown; skipped?: string; code?: string; done?: boolean; localRecordPending?: boolean };
  if (res.status === 200) {
    if (body.skipped) return "skipped";
    if (body.done || body.localRecordPending) await finalizeAutoPost(sa, q.docId, q.reviewName, key, q.enabledByUid, new Date());
    if (body.done) return "skipped";
    await audit(sa, q.docId, target.agencyId, q.enabledByUid);
    return "posted";
  }
  if (res.status === 404 || (res.status === 409 && body.code === "in_progress")) return "skipped";
  console.warn(`[reputation/auto-reply] post failed sa=${sa} status=${res.status} code=${body.code ?? "-"}`);
  if (PER_REVIEW_CODES.has(body.code ?? "")) {
    await markPostFailed(sa, q.docId, textHash, new Date());
    return "skipped";
  }
  return "stop";
}

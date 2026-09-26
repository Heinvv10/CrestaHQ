import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { recordAuditEvent } from "@/lib/audit/record";
import { loadReplyTarget, postReply, replyPreflight } from "@/lib/gbp/reply";
import { confirmAutoPost } from "./confirm";
import { autoReplyKey, textHashOf } from "./store";

/**
 * Post ONE stored `auto_queued` draft — exactly its stored bytes, under the
 * key `auto:{reviewDocId}:{textHash}`, so a retry after a failed post is the
 * same attempt and can never post two different texts (AUTO_REPLY_V1_PLAN.md
 * step 4). In order: the run's deadline; the reply route's own review lookup
 * and preflight (gate, deployment, connection, fake fence); the final
 * re-check transaction (confirm.ts); then `postReply` with `requireNoReply`,
 * so a reply that reached the cache after all that is never overwritten.
 *
 *   posted   Google accepted it; `autoReplied` stamped, audited
 *   skipped  this review is not posted now (gone, changed, replied, held)
 *   stop     nothing more should post in this run (deadline, pause, cap,
 *            lease, a Google failure) — the draft stays queued for the next run
 */

export const AUTO_REPLY_ACTOR = "system:auto-reply";

export type PostResult = "posted" | "skipped" | "stop";

const kind = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export async function postQueued(
  sa: string,
  q: { runId: string; docId: string; text: string; enabledByUid: string; deadline: number },
): Promise<PostResult> {
  if (Date.now() >= q.deadline) return "stop";
  const target = await loadReplyTarget(sa, q.docId);
  if (!target) return "skipped";
  if (await replyPreflight(sa)) return "stop";

  const textHash = textHashOf(q.text);
  const confirmed = await confirmAutoPost(sa, { runId: q.runId, docId: q.docId, textHash }, Date.now());
  if (confirmed === "stale" || confirmed === "approval") return "skipped";
  if (confirmed !== "go") return "stop";

  const res = await postReply(
    sa, target, { comment: q.text, idempotencyKey: autoReplyKey(q.docId, textHash) }, AUTO_REPLY_ACTOR,
    { createdByUid: q.enabledByUid },
  );
  const body = (await res.json()) as { reply?: unknown; skipped?: string; code?: string };
  if (res.status === 409 && body.code === "in_progress") return "skipped";
  if (res.status !== 200) {
    console.warn(`[reputation/auto-reply] post failed sa=${sa} status=${res.status} code=${body.code ?? "-"}`);
    return "stop";
  }
  if (body.skipped) return "skipped";
  try {
    await recordAuditEvent(getAdminDb(), {
      action: "review.auto_replied",
      actor: { type: "system", id: "auto-reply" },
      target: { type: "review", id: q.docId },
      agencyId: target.agencyId,
      subAccountId: sa,
      changes: [],
      onBehalfOfUid: q.enabledByUid,
    });
  } catch (err) {
    // The reply is public already; the gbpEvents row (written with it) stands.
    console.error(`[reputation/auto-reply] audit event not recorded sa=${sa}: ${kind(err)}`);
  }
  return "posted";
}

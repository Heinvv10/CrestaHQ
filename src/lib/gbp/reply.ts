import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { withGbpAccess } from "./access";
import { GbpFakeRefusedError, getGbpProviderFor } from "./provider/select";
import { GbpProviderError, type GbpReviewReply } from "./provider/types";
import {
  claimAttempt, claimDeleteLock, failAttempt, markAttemptSucceeded, recordReplyChange, releaseLock,
  type AttemptTarget,
} from "./reply-attempts";
import { gbpErrorResponse, gbpPreconditions, gbpRefusal } from "./route-support";
import { reviewsCollection } from "./sync/types";
import { GbpNotConnectedError } from "./tokens";

/**
 * Replies to Google reviews. The ONLY caller of the provider's `putReply` /
 * `deleteReply`, reached from exactly two places: the explicit human reply
 * route, and the review auto-reply engine (lib/reputation/auto-reply/run.ts,
 * AUTO_REPLY_V1_PLAN.md) — which posts WITHOUT a click, only for a
 * sub-account whose admin switched auto-reply on, only rating-only reviews of
 * a star set to Auto, and only while the deployment's
 * `REVIEWS_AUTO_REPLY_ENABLED` kill switch is set. No sync, workflow or other
 * AI path posts one, and nothing deletes one automatically. Each attempt
 * calls Google exactly once (withGbpAccess's single refresh-and-retry after a
 * 401 aside); a retry reuses the same key. Never logs the reply text.
 */

export const MAX_REPLY_CHARS = 4000;
const DOC_ID_RE = /^[0-9a-f]{40}$/;

export interface ReplyTarget extends AttemptTarget {
  reviewName: string;
}

/**
 * The review an admin of THIS sub-account may reply to: a well-formed cache
 * id naming an ACTIVE review of the CURRENT listing under this sub-account.
 * Anything else — a guessed id from another tenant included — is null (404).
 */
export async function loadReplyTarget(subAccountId: string, docId: string): Promise<ReplyTarget | null> {
  if (!DOC_ID_RE.test(docId)) return null;
  const db = getAdminDb();
  const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data();
  const review = (await db.doc(`${reviewsCollection(subAccountId)}/${docId}`).get()).data();
  const listing = sub?.googleListing?.locationName ?? null;
  if (!review || review.state !== "active" || !listing || review.locationName !== listing) return null;
  return { docId, agencyId: String(sub?.agencyId ?? ""), reviewName: String(review.reviewName) };
}

/** `{comment, idempotencyKey}` exactly as sent — the comment is trimmed only to test for emptiness. */
export function parseReplyBody(raw: unknown): { comment: string; idempotencyKey: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { comment, idempotencyKey } = raw as Record<string, unknown>;
  if (typeof comment !== "string" || !comment.trim() || comment.length > MAX_REPLY_CHARS) return null;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return null;
  return { comment, idempotencyKey };
}

/** Deployment, connection and fake-fence checks before anything of ours is written. */
export async function replyPreflight(subAccountId: string): Promise<NextResponse | null> {
  const ready = await gbpPreconditions(subAccountId);
  if (ready instanceof NextResponse) return ready;
  try {
    await getGbpProviderFor(subAccountId);
  } catch (err) {
    if (!(err instanceof GbpFakeRefusedError)) throw err;
    return gbpRefusal(503, "not_configured", "Google isn't configured on this deployment.");
  }
  return null;
}

const nameOf = (err: unknown) => (err instanceof Error ? err.name : typeof err);

function kindOf(err: unknown): string {
  if (err instanceof GbpProviderError) return err.kind;
  if (err instanceof GbpNotConnectedError) return "not_connected";
  return "internal";
}

/**
 * The auto-reply engine's post: never to a review that has or had a reply,
 * and only the queued bytes `textHash` on an Auto star (`requireNoReply` —
 * refused as 200 `{skipped: "already_replied" | "not_queued"}`), recorded as
 * `autoReplied` and attributed to `createdByUid`, whoever switched auto-reply on.
 */
export interface AutoPost {
  createdByUid: string;
  textHash: string;
}

export async function postReply(
  subAccountId: string,
  target: ReplyTarget,
  body: { comment: string; idempotencyKey: string },
  actorUid: string,
  auto?: AutoPost,
): Promise<NextResponse> {
  const now = new Date();
  const claim = await claimAttempt(subAccountId, target, body, actorUid, now, auto
    ? { requireNoReply: { textHash: auto.textHash }, createdByUid: auto.createdByUid }
    : {});
  if (claim.kind === "already_replied" || claim.kind === "not_queued") return NextResponse.json({ skipped: claim.kind });
  if (claim.kind === "reused") {
    return gbpRefusal(409, "idempotency_key_reused", "This reply was already submitted with different text — start a new reply.");
  }
  if (claim.kind === "in_progress") {
    return gbpRefusal(409, "in_progress", "This reply is still being posted — try again in a moment.");
  }
  // The auto path is told a `done` apart: it must not audit or count it again.
  if (claim.kind === "done") return NextResponse.json(auto ? { reply: claim.reply, done: true } : { reply: claim.reply });
  if (claim.kind === "gone") return gbpRefusal(404, "not_found", "Review not found.");

  let reply: GbpReviewReply;
  try {
    reply = await withGbpAccess(subAccountId, (p, token) => p.putReply(token, target.reviewName, body.comment));
  } catch (err) {
    // Recording the failure must never mask Google's answer.
    await failAttempt(subAccountId, target, body.idempotencyKey, kindOf(err)).catch((recordErr: unknown) =>
      console.error(`[gbp/reply] failed attempt not recorded sa=${subAccountId}: ${nameOf(recordErr)}`),
    );
    return gbpErrorResponse(err, subAccountId, "gbp/reply");
  }
  try {
    await recordReplyChange(subAccountId, target, reply, {
      type: "reply_posted", actorUid, key: body.idempotencyKey, now, auto,
    });
  } catch (err) {
    // The reply IS public on Google; only our record of it failed. Say so —
    // the next sync brings it into the cache — and stop a same-key retry
    // from posting again (best effort).
    console.error(`[gbp/reply] posted but not recorded locally sa=${subAccountId}: ${nameOf(err)}`);
    await markAttemptSucceeded(subAccountId, body.idempotencyKey, reply).catch((markErr: unknown) =>
      console.error(`[gbp/reply] attempt not marked succeeded sa=${subAccountId}: ${nameOf(markErr)}`),
    );
    // recordReplyChange's transaction is what would have released the lock —
    // it failed too, so release it on its own (best effort).
    await releaseLock(subAccountId, target.docId, body.idempotencyKey).catch((lockErr: unknown) =>
      console.error(`[gbp/reply] lock not released sa=${subAccountId}: ${nameOf(lockErr)}`),
    );
    return NextResponse.json({ reply, localRecordPending: true });
  }
  return NextResponse.json({ reply });
}

/** API only in v1 (v1 makes deletion optional): there is no delete button. */
export async function deleteReplyFor(subAccountId: string, target: ReplyTarget, actorUid: string): Promise<NextResponse> {
  const claim = await claimDeleteLock(subAccountId, target, new Date());
  if (claim.kind === "gone") return gbpRefusal(404, "not_found", "Review not found.");
  if (claim.kind === "in_progress") {
    return gbpRefusal(409, "in_progress", "This review has a reply change in progress — try again in a moment.");
  }
  // DELETE has no idempotency key of its own — the ledger is for POST only —
  // so this lock is always released here rather than by recordReplyChange.
  const release = () =>
    releaseLock(subAccountId, target.docId, claim.key).catch((lockErr: unknown) =>
      console.error(`[gbp/reply] lock not released sa=${subAccountId}: ${nameOf(lockErr)}`),
    );
  try {
    await withGbpAccess(subAccountId, (p, token) => p.deleteReply(token, target.reviewName));
  } catch (err) {
    await release();
    return gbpErrorResponse(err, subAccountId, "gbp/reply");
  }
  try {
    await recordReplyChange(subAccountId, target, null, { type: "reply_deleted", actorUid, key: null, now: new Date() });
  } catch (err) {
    console.error(`[gbp/reply] deleted but not recorded locally sa=${subAccountId}: ${nameOf(err)}`);
    await release();
    return NextResponse.json({ ok: true, localRecordPending: true });
  }
  await release();
  return NextResponse.json({ ok: true });
}

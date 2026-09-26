import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import type { GbpReviewReply } from "./provider/types";
import { autoReplyNeverPath, neverMarker } from "./auto-reply-never";
import { autoClaimRefusal } from "./reply-auto-guard";
import { contentHash } from "./sync/store";
import { reviewsCollection, toMillis } from "./sync/types";

/**
 * The idempotency ledger for explicit replies —
 * `subAccounts/{id}/gbpReplyAttempts/{sha256(idempotencyKey)[:40]}` (no client
 * rule: default deny). One doc per compose session's key: `pending` while the
 * provider call is in flight, then `succeeded` or `failed`. It stores a hash
 * of the reply, never its text.
 *
 * Plus a per-review in-flight lock, `replyInFlight {key, at}` on the cached
 * review, taken in the same claim transaction: while one key's call is in
 * flight, a DIFFERENT key on the same review is refused (Google keeps the
 * last write, so an abandoned text could otherwise go public after an edit).
 * Only the attempt that holds it releases it.
 */

/**
 * A pending attempt (or lock) younger than this is a request still in flight.
 * The reply fetch aborts after 30 s, so an older one is dead.
 */
export const PENDING_MS = 2 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const attemptId = (key: string) => sha256(key).slice(0, 40);
const attemptRef = (sa: string, key: string) =>
  getAdminDb().doc(`subAccounts/${sa}/gbpReplyAttempts/${attemptId(key)}`);
const reviewRefOf = (sa: string, docId: string) => getAdminDb().doc(`${reviewsCollection(sa)}/${docId}`);
const holds = (lock: unknown, key: string) => (lock as { key?: unknown } | null | undefined)?.key === attemptId(key);

export interface AttemptTarget {
  docId: string;
  agencyId: string;
  /** The Google review name (ReplyTarget has it); else read from the cached review. */
  reviewName?: string;
}

export type Claim =
  | { kind: "new" }
  | { kind: "done"; reply: GbpReviewReply }
  | { kind: "in_progress" }
  | { kind: "reused" }
  /** The cached review went away between the lookup and the claim. */
  | { kind: "gone" }
  /** `requireNoReply` only: the review has, or ever had, a reply (any text, any author). */
  | { kind: "already_replied" }
  /** `requireNoReply` only: its draft is no longer these queued bytes, or its star is no longer Auto. */
  | { kind: "not_queued" };

/**
 * Claim the attempt for `idempotencyKey` in one transaction. A key already
 * used for other text or another review is `reused`; a succeeded attempt is
 * `done` (no provider call); a pending one under {@link PENDING_MS} — or
 * another key's live lock on the review — is `in_progress`; a review whose
 * CACHED reply is already byte-equal is `done` without a call. Otherwise the
 * attempt becomes `pending`, the review's lock is taken, and the caller calls
 * Google exactly once.
 *
 * `requireNoReply` (the auto-reply engine only — AUTO_REPLY_V1_PLAN.md): a
 * review that has or ever had a reply (`reply` / sticky `hadReply`) is
 * `already_replied` — nothing is claimed and its `pendingReply` is cleared in
 * the same transaction — so an automatic post never overwrites or replaces a
 * reply; one whose draft is no longer the queued `textHash`, or whose star is
 * no longer Auto, is `not_queued` (reply-auto-guard.ts). Without it (a
 * human's explicit reply) a different reply is posted over, as an edit.
 * The attempt records `createdByUid` (the tenant anchor: `createdByUid` when
 * given — the auto path's enabler — else the actor) and `actorUid`.
 */
export async function claimAttempt(
  sa: string,
  target: AttemptTarget,
  body: { comment: string; idempotencyKey: string },
  actorUid: string,
  now: Date,
  opts: { requireNoReply?: { textHash: string }; createdByUid?: string } = {},
): Promise<Claim> {
  const db = getAdminDb();
  const ref = attemptRef(sa, body.idempotencyKey);
  const reviewRef = reviewRefOf(sa, target.docId);
  const commentHash = sha256(body.comment);
  const live = (at: unknown) => now.getTime() - (toMillis(at) ?? 0) < PENDING_MS;
  return db.runTransaction(async (tx): Promise<Claim> => {
    const snap = await tx.get(ref);
    const review = await tx.get(reviewRef);
    const prior = snap.exists ? snap.data() : undefined;
    if (prior) {
      if (prior.commentHash !== commentHash || prior.reviewDocId !== target.docId) return { kind: "reused" };
      if (prior.status === "succeeded") {
        return { kind: "done", reply: { comment: body.comment, updateTime: String(prior.replyUpdateTime) } };
      }
      if (prior.status === "pending" && live(prior.at)) return { kind: "in_progress" };
    }
    const data = review.data();
    if (!data) return { kind: "gone" };
    if (opts.requireNoReply) {
      const refusal = await autoClaimRefusal(
        tx, db.doc(`subAccounts/${sa}`), db.doc(autoReplyNeverPath(sa, String(data.reviewName ?? target.reviewName ?? ""))),
        data, opts.requireNoReply.textHash,
      );
      if (refusal === "already_replied") {
        tx.update(reviewRef, { pendingReply: null });
        return { kind: "already_replied" };
      }
      if (refusal) return { kind: refusal };
    }
    const lock = data.replyInFlight as { key?: unknown; at?: unknown } | null | undefined;
    if (lock && !holds(lock, body.idempotencyKey) && live(lock.at)) return { kind: "in_progress" };

    const base = {
      agencyId: target.agencyId, subAccountId: sa, createdByUid: opts.createdByUid ?? actorUid, actorUid, reviewDocId: target.docId,
      commentHash, at: now, errorKind: null,
    };
    // Compared with the CACHED reply: a reply edited at Google since the last
    // sync is not seen here, and then this posts (Google keeps the last write).
    const current = data.reply as GbpReviewReply | null | undefined;
    if (current && current.comment === body.comment) {
      tx.set(ref, { ...base, status: "succeeded", replyUpdateTime: current.updateTime });
      return { kind: "done", reply: current };
    }
    tx.set(ref, { ...base, status: "pending", replyUpdateTime: null });
    tx.update(reviewRef, { replyInFlight: { key: attemptId(body.idempotencyKey), at: now } });
    return { kind: "new" };
  });
}

export type DeleteClaim = { kind: "new"; key: string } | { kind: "in_progress" } | { kind: "gone" };

/**
 * DELETE takes the same per-review lock as a reply POST — it has no
 * idempotency key of its own, so one is minted here (never stored anywhere
 * but the lock, never logged). Blocked by a DIFFERENT live lock (a pending
 * POST or another pending DELETE); a review with no lock, or one only this
 * key already holds, is claimed.
 */
export async function claimDeleteLock(sa: string, target: AttemptTarget, now: Date): Promise<DeleteClaim> {
  const db = getAdminDb();
  const reviewRef = reviewRefOf(sa, target.docId);
  const key = randomBytes(20).toString("hex");
  const live = (at: unknown) => now.getTime() - (toMillis(at) ?? 0) < PENDING_MS;
  return db.runTransaction(async (tx): Promise<DeleteClaim> => {
    const data = (await tx.get(reviewRef)).data();
    // Removed by a sync or retention since the route looked it up: nothing to lock or delete.
    if (!data) return { kind: "gone" };
    const lock = data.replyInFlight as { key?: unknown; at?: unknown } | null | undefined;
    if (lock && !holds(lock, key) && live(lock.at)) return { kind: "in_progress" };
    tx.update(reviewRef, { replyInFlight: { key: attemptId(key), at: now } });
    return { kind: "new", key };
  });
}

/** The provider call failed: the attempt `failed`, and this attempt's lock released. */
export async function failAttempt(sa: string, target: AttemptTarget, key: string, errorKind: string): Promise<void> {
  const db = getAdminDb();
  const reviewRef = reviewRefOf(sa, target.docId);
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(reviewRef)).data();
    tx.set(attemptRef(sa, key), { status: "failed", errorKind }, { merge: true });
    if (d && holds(d.replyInFlight, key)) tx.update(reviewRef, { replyInFlight: null });
  });
}

/**
 * Release this key's per-review lock unconditionally, on its own — for when
 * the transaction that would otherwise have released it (recordReplyChange)
 * itself failed. Never another key's lock. Best-effort: the caller logs a
 * failure here, it never masks the outcome already decided.
 */
export async function releaseLock(sa: string, docId: string, key: string): Promise<void> {
  const db = getAdminDb();
  const reviewRef = reviewRefOf(sa, docId);
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(reviewRef)).data();
    if (d && holds(d.replyInFlight, key)) tx.update(reviewRef, { replyInFlight: null });
  });
}

/** Whether the attempt for `key` is already `succeeded` (Google accepted it). */
export async function attemptSucceeded(sa: string, key: string): Promise<boolean> {
  return (await attemptRef(sa, key).get()).data()?.status === "succeeded";
}

/** Google accepted the reply but the local record failed — at least stop a retry re-posting it. */
export async function markAttemptSucceeded(sa: string, key: string, reply: GbpReviewReply): Promise<void> {
  await attemptRef(sa, key).set({ status: "succeeded", replyUpdateTime: reply.updateTime, errorKind: null }, { merge: true });
}

const isoOf = (v: unknown) => {
  const ms = toMillis(v);
  return ms === null ? "" : new Date(ms).toISOString();
};

/**
 * After Google accepted a reply (or its deletion): the cached review's reply
 * and content hash — so the next sync sees it unchanged — this attempt's lock
 * released, the attempt (when there is one) and an audit event, in one
 * transaction. Nothing else on the review moves (pass bookkeeping stays the
 * sync's). Events carry ids, never reply text.
 *
 * A posted reply also clears the review's `pendingReply` (a held or queued
 * draft is moot once a reply exists); an automatic one (`auto`) stamps
 * `autoReplied {at, key}` and its event carries `createdByUid` = whoever
 * switched auto-reply on, `actorUid` = "system:auto-reply".
 */
export async function recordReplyChange(
  sa: string,
  target: AttemptTarget,
  reply: GbpReviewReply | null,
  change: {
    type: "reply_posted" | "reply_deleted"; actorUid: string; key: string | null; now: Date;
    auto?: { createdByUid: string };
  },
): Promise<void> {
  const db = getAdminDb();
  const reviewRef = reviewRefOf(sa, target.docId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reviewRef);
    const d = snap.data();
    // A cache cleared meanwhile (listing changed) is not recreated.
    if (d && d.state === "active") {
      const hash = contentHash({
        starRating: d.starRating ?? null, comment: d.comment ?? null, updateTime: isoOf(d.updateTime), reply,
      });
      const release = change.key && holds(d.replyInFlight, change.key) ? { replyInFlight: null } : {};
      // `hadReply` is sticky: deleting the reply later never clears it (auto-reply never replaces one).
      const posted = change.type === "reply_posted" ? { pendingReply: null, hadReply: true } : {};
      const auto = change.auto ? { autoReplied: { at: change.now, key: change.key } } : {};
      tx.update(reviewRef, { reply, contentHash: hash, ...release, ...posted, ...auto });
    }
    const reviewName = target.reviewName ?? (typeof d?.reviewName === "string" ? d.reviewName : null);
    if (change.type === "reply_posted" && reviewName) {
      // Outside the cache, so a cache clear cannot forget it (auto-reply never replaces a reply).
      const anchor = { agencyId: target.agencyId, subAccountId: sa, createdByUid: change.auto?.createdByUid ?? change.actorUid };
      const star = typeof d?.starRating === "number" ? d.starRating : null;
      const marker = neverMarker(anchor, change.auto ? "auto_replied" : "replied", change.now, target.docId, star);
      tx.set(db.doc(autoReplyNeverPath(sa, reviewName)), marker);
    }
    if (change.key) {
      tx.set(attemptRef(sa, change.key), { status: "succeeded", replyUpdateTime: reply?.updateTime ?? null, errorKind: null }, { merge: true });
    }
    tx.set(db.collection(`subAccounts/${sa}/gbpEvents`).doc(), {
      type: change.type, agencyId: target.agencyId, subAccountId: sa, createdByUid: change.auto?.createdByUid ?? change.actorUid,
      actorUid: change.actorUid, reviewDocId: target.docId, at: change.now,
    });
  });
}

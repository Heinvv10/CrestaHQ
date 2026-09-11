import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import type { GbpReviewReply } from "./provider/types";
import { contentHash } from "./sync/store";
import { reviewsCollection, toMillis } from "./sync/types";

/**
 * The idempotency ledger for explicit replies —
 * `subAccounts/{id}/gbpReplyAttempts/{sha256(idempotencyKey)[:40]}` (no client
 * rule: default deny). One doc per compose session's key: `pending` while the
 * provider call is in flight, then `succeeded` or `failed`. It stores a hash
 * of the reply, never its text.
 */

/** A pending attempt younger than this is someone else's request still in flight. */
export const PENDING_MS = 2 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const attemptRef = (sa: string, key: string) =>
  getAdminDb().doc(`subAccounts/${sa}/gbpReplyAttempts/${sha256(key).slice(0, 40)}`);

export interface AttemptTarget {
  docId: string;
  agencyId: string;
}

export type Claim =
  | { kind: "new" }
  | { kind: "done"; reply: GbpReviewReply }
  | { kind: "in_progress" }
  | { kind: "reused" };

/**
 * Claim the attempt for `idempotencyKey` in one transaction. A key already
 * used for other text or another review is `reused`; a succeeded attempt is
 * `done` (no provider call); a pending one under {@link PENDING_MS} is
 * `in_progress`; a review whose reply is already byte-equal is `done` without
 * a call. Otherwise the attempt becomes `pending` and the caller calls Google
 * exactly once.
 */
export async function claimAttempt(
  sa: string,
  target: AttemptTarget,
  body: { comment: string; idempotencyKey: string },
  actorUid: string,
  now: Date,
): Promise<Claim> {
  const db = getAdminDb();
  const ref = attemptRef(sa, body.idempotencyKey);
  const reviewRef = db.doc(`${reviewsCollection(sa)}/${target.docId}`);
  const commentHash = sha256(body.comment);
  return db.runTransaction(async (tx): Promise<Claim> => {
    const snap = await tx.get(ref);
    const review = await tx.get(reviewRef);
    const prior = snap.exists ? snap.data() : undefined;
    if (prior) {
      if (prior.commentHash !== commentHash || prior.reviewDocId !== target.docId) return { kind: "reused" };
      if (prior.status === "succeeded") {
        return { kind: "done", reply: { comment: body.comment, updateTime: String(prior.replyUpdateTime) } };
      }
      if (prior.status === "pending" && now.getTime() - (toMillis(prior.at) ?? 0) < PENDING_MS) {
        return { kind: "in_progress" };
      }
    }
    const base = {
      agencyId: target.agencyId, subAccountId: sa, createdByUid: actorUid, reviewDocId: target.docId,
      commentHash, at: now, errorKind: null,
    };
    const current = review.data()?.reply as GbpReviewReply | null | undefined;
    if (current && current.comment === body.comment) {
      tx.set(ref, { ...base, status: "succeeded", replyUpdateTime: current.updateTime });
      return { kind: "done", reply: current };
    }
    tx.set(ref, { ...base, status: "pending", replyUpdateTime: null });
    return { kind: "new" };
  });
}

export async function failAttempt(sa: string, key: string, errorKind: string): Promise<void> {
  await attemptRef(sa, key).set({ status: "failed", errorKind }, { merge: true });
}

const isoOf = (v: unknown) => {
  const ms = toMillis(v);
  return ms === null ? "" : new Date(ms).toISOString();
};

/**
 * After Google accepted a reply (or its deletion): the cached review's reply
 * and content hash — so the next sync sees it unchanged — the attempt (when
 * there is one) and an audit event, in one transaction. Nothing else on the
 * review moves (pass bookkeeping stays the sync's). Events carry ids, never
 * reply text.
 */
export async function recordReplyChange(
  sa: string,
  target: AttemptTarget,
  reply: GbpReviewReply | null,
  change: { type: "reply_posted" | "reply_deleted"; actorUid: string; key: string | null; now: Date },
): Promise<void> {
  const db = getAdminDb();
  const reviewRef = db.doc(`${reviewsCollection(sa)}/${target.docId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reviewRef);
    const d = snap.data();
    // A cache cleared meanwhile (listing changed) is not recreated.
    if (d && d.state === "active") {
      const hash = contentHash({
        starRating: d.starRating ?? null, comment: d.comment ?? null, updateTime: isoOf(d.updateTime), reply,
      });
      tx.update(reviewRef, { reply, contentHash: hash });
    }
    if (change.key) {
      tx.set(attemptRef(sa, change.key), { status: "succeeded", replyUpdateTime: reply?.updateTime ?? null, errorKind: null }, { merge: true });
    }
    tx.set(db.collection(`subAccounts/${sa}/gbpEvents`).doc(), {
      type: change.type, agencyId: target.agencyId, subAccountId: sa, createdByUid: change.actorUid,
      actorUid: change.actorUid, reviewDocId: target.docId, at: change.now,
    });
  });
}

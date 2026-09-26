import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { reviewsCollection, toMillis } from "@/lib/gbp/sync/types";
import { reviewBasis } from "../sentiment-basis";
import { PENDING_REASONS, type DecidePending, type PendingReason } from "./decide";

/**
 * The auto-reply engine's Firestore state (AUTO_REPLY_V1_PLAN.md). All server
 * only (no client rule: default deny), no index:
 *
 *   gbpReviews/{docId}.pendingReply     {text, textHash, basisHash, reason, at, model}
 *                                       — the engine's draft (text null when there
 *                                       is none); purged with the review
 *   subAccounts/{id}/autoReplyDismissed/{reviewDocId}
 *                                       {basisHash, at, byUid} + tenant keys — a
 *                                       Discard, outside the cache so it survives a
 *                                       cache clear; an id and a hash, no content
 *   private/autoReplyLease              {runId, until} — one run per sub-account
 *   private/autoReplyUsage              {day (SAST), posts} — the 20 posts a day
 *
 * Auto DRAFTS are counted in `private/sentimentUsage.autoDraftCalls` by
 * beginDraftCall (draft.ts), on the drafts' own UTC day.
 */

export const AUTO_REPLY_LEASE_TTL_MS = 5 * 60_000;
export const autoReplyLeasePath = (sa: string) => `subAccounts/${sa}/private/autoReplyLease`;
export const autoReplyUsagePath = (sa: string) => `subAccounts/${sa}/private/autoReplyUsage`;
export const autoReplyDismissedCollection = (sa: string) => `subAccounts/${sa}/autoReplyDismissed`;

/** The posts cap's day: the calendar date in South Africa (UTC+2, no DST). */
export const sastDay = (ms: number) => new Date(ms + 2 * 3600_000).toISOString().slice(0, 10);
export const textHashOf = (text: string) => createHash("sha256").update(text).digest("hex");
/** The auto post's idempotency key: a retry of the same stored bytes is the same attempt. */
export const autoReplyKey = (docId: string, textHash: string) => `auto:${docId}:${textHash}`;

export interface StoredPending {
  text: string | null;
  textHash: string | null;
  basisHash: string | null;
  reason: PendingReason;
  at: unknown;
  model: string | null;
}

export function readPending(raw: unknown): StoredPending | null {
  const p = raw as Partial<StoredPending> | null | undefined;
  if (!p || !PENDING_REASONS.includes(p.reason as PendingReason)) return null;
  return {
    text: typeof p.text === "string" ? p.text : null,
    textHash: typeof p.textHash === "string" ? p.textHash : null,
    basisHash: typeof p.basisHash === "string" ? p.basisHash : null,
    reason: p.reason as PendingReason,
    at: p.at ?? null,
    model: typeof p.model === "string" ? p.model : null,
  };
}

export const toDecidePending = (p: StoredPending | null): DecidePending | null =>
  p && { reason: p.reason, basisHash: p.basisHash, atMs: toMillis(p.at), hasText: p.text !== null && p.textHash !== null };

const leaseRef = (sa: string) => getAdminDb().doc(autoReplyLeasePath(sa));

/** Take the per-sub-account lease unless another run holds it unexpired. */
export async function acquireAutoReplyLease(sa: string, runId: string, now: number): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(leaseRef(sa))).data() as { runId?: string | null; until?: number } | undefined;
    if (d?.runId && d.runId !== runId && (d.until ?? 0) > now) return false;
    tx.set(leaseRef(sa), { runId, until: now + AUTO_REPLY_LEASE_TTL_MS }, { merge: true });
    return true;
  });
}

/** Still ours → renewed, true; lost (expired and taken) → false. */
export async function renewAutoReplyLease(sa: string, runId: string, now: number): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(leaseRef(sa))).data() as { runId?: string | null } | undefined;
    if (d?.runId !== runId) return false;
    tx.set(leaseRef(sa), { until: now + AUTO_REPLY_LEASE_TTL_MS }, { merge: true });
    return true;
  });
}

export async function releaseAutoReplyLease(sa: string, runId: string): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(leaseRef(sa))).data() as { runId?: string | null } | undefined;
    if (d?.runId === runId) tx.set(leaseRef(sa), { runId: null, until: 0 }, { merge: true });
  });
}

export async function postsToday(sa: string, now: number): Promise<number> {
  const d = (await getAdminDb().doc(autoReplyUsagePath(sa)).get()).data() as { day?: string; posts?: number } | undefined;
  return d?.day === sastDay(now) ? (d.posts ?? 0) : 0;
}

export async function autoDraftsToday(usagePath: string, now: number): Promise<number> {
  const d = (await getAdminDb().doc(usagePath).get()).data() as { draftsDay?: string; autoDraftCalls?: number } | undefined;
  return d?.draftsDay === new Date(now).toISOString().slice(0, 10) ? (d.autoDraftCalls ?? 0) : 0;
}

type ReviewData = Record<string, unknown>;

/**
 * Store the engine's result for one review — only if the review is still the
 * one it decided on: active, unreplied, the same basis, and not Discarded
 * meanwhile. Returns whether it wrote. A human reply or a Discard landing
 * during the draft call therefore wins.
 */
export async function storePending(
  sa: string,
  docId: string,
  pending: { text: string | null; basisHash: string; reason: Exclude<PendingReason, "dismissed">; model: string | null },
  now: Date,
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`${reviewsCollection(sa)}/${docId}`);
  const dismissedRef = db.doc(`${autoReplyDismissedCollection(sa)}/${docId}`);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as ReviewData | undefined;
    const dismissed = (await tx.get(dismissedRef)).data() as { basisHash?: unknown } | undefined;
    if (!d || d.state !== "active" || d.reply || reviewBasis(d) !== pending.basisHash) return false;
    if (dismissed?.basisHash === pending.basisHash) return false;
    const current = readPending(d.pendingReply);
    if (current?.reason === "dismissed" && current.basisHash === pending.basisHash) return false;
    const textHash = pending.text === null ? null : textHashOf(pending.text);
    tx.update(ref, { pendingReply: { ...pending, textHash, at: now } });
    return true;
  });
}

/**
 * Discard (the Reviews tab's button, PR 3): mark the review's draft
 * `dismissed` for its current basis, AND record it outside the cache so a
 * cache clear cannot resurrect it. The engine never drafts or posts that
 * review again unless its content changes. False when the review is gone.
 */
export async function dismissAutoReply(sa: string, docId: string, byUid: string, now: Date): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`${reviewsCollection(sa)}/${docId}`);
  const subRef = db.doc(`subAccounts/${sa}`);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as ReviewData | undefined;
    const sub = (await tx.get(subRef)).data();
    const basisHash = d?.state === "active" ? reviewBasis(d) : null;
    if (!basisHash) return false;
    tx.update(ref, { pendingReply: { text: null, textHash: null, basisHash, reason: "dismissed", at: now, model: null } });
    tx.set(db.doc(`${autoReplyDismissedCollection(sa)}/${docId}`), {
      agencyId: String(sub?.agencyId ?? ""), subAccountId: sa, createdByUid: byUid, byUid, basisHash, at: now,
    });
    return true;
  });
}

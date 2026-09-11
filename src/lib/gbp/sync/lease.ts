import "server-only";

import type { Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { LEASE_TTL_MS, syncStatePath, type SyncState } from "./types";

/**
 * One sync per sub-account at a time. The lease lives in the locked
 * `private/gbpSyncState` doc next to the pass cursor; it is taken in a
 * transaction, and EVERY write a run makes afterwards goes through
 * {@link commitGuarded}, which re-checks in its own transaction that the lease
 * is still this run's. So a run that outlived its TTL, or whose cache was
 * cleared under it (listing changed, disconnected), cannot write another
 * review or summary.
 */

export class LeaseLostError extends Error {
  constructor() {
    super("GBP sync lease lost");
    this.name = "LeaseLostError";
  }
}

const EMPTY: SyncState = { lease: null, pass: null };

function readState(data: unknown): SyncState {
  const d = (data ?? {}) as Partial<SyncState>;
  return { lease: d.lease ?? null, pass: d.pass ?? null };
}

/** The state as of acquisition, or null when another run holds a live lease. */
export async function acquireLease(
  subAccountId: string,
  runId: string,
  now: Date,
): Promise<SyncState | null> {
  const db = getAdminDb();
  const ref = db.doc(syncStatePath(subAccountId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const state = snap.exists ? readState(snap.data()) : EMPTY;
    if (state.lease && state.lease.until > now.getTime()) return null;
    const lease = { runId, until: now.getTime() + LEASE_TTL_MS };
    tx.set(ref, { ...state, lease });
    return { ...state, lease };
  });
}

/** Release — only if the lease is still ours, and never recreating a cleared doc. */
export async function releaseLease(subAccountId: string, runId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(syncStatePath(subAccountId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || readState(snap.data()).lease?.runId !== runId) return;
    tx.set(ref, { lease: null }, { merge: true });
  });
}

export type GuardedOp = (tx: Transaction) => void;
const CHUNK = 400;

/**
 * Apply `ops` in transactions of at most {@link CHUNK} writes, each of which
 * first confirms the lease is still `runId`'s. Throws LeaseLostError (having
 * written nothing in that chunk) when it is not.
 */
export async function commitGuarded(
  subAccountId: string,
  runId: string,
  ops: GuardedOp[],
): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(syncStatePath(subAccountId));
  for (let i = 0; i < ops.length; i += CHUNK) {
    const chunk = ops.slice(i, i + CHUNK);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || readState(snap.data()).lease?.runId !== runId) throw new LeaseLostError();
      for (const op of chunk) op(tx);
    });
  }
}

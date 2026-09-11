import "server-only";

import type { Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import { LEASE_TTL_MS, syncStatePath, type SkipReason, type SyncState } from "./types";

/**
 * One sync per sub-account at a time. The lease lives in the locked
 * `private/gbpSyncState` doc next to the pass cursor. It is taken in a
 * transaction that ALSO re-reads the sub-account: the run decided what to do
 * from an earlier read, and a listing clear/change, a disconnect, a reconnect
 * flag or the gate going off in between would otherwise let it write the old
 * listing's reviews into a freshly cleared cache. EVERY write a run makes
 * afterwards goes through {@link commitGuarded}, which re-checks in its own
 * transaction that the lease is still this run's (each page commit also
 * renews it).
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
  return { ...d, lease: d.lease ?? null, pass: d.pass ?? null };
}

/** What the run decided from its read of the sub-account; the lease insists it still holds. */
export interface LeaseExpectation {
  locationName: string | null;
  skipReason: SkipReason | null;
  /** The same classification the run used, applied to the fresh read. */
  classify: (sub: SubAccountDoc) => SkipReason | null;
}

export type LeaseResult =
  /** `sub` is the sub-account as read INSIDE the lease transaction. */
  | { ok: true; state: SyncState; sub: SubAccountDoc }
  | { ok: false; reason: "already_running" | "listing_changed" };

export async function acquireLease(
  subAccountId: string,
  runId: string,
  now: Date,
  expect: LeaseExpectation,
): Promise<LeaseResult> {
  const db = getAdminDb();
  const ref = db.doc(syncStatePath(subAccountId));
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  return db.runTransaction(async (tx) => {
    const [snap, subSnap] = [await tx.get(ref), await tx.get(subRef)];
    const sub = (subSnap.data() ?? {}) as SubAccountDoc;
    if (
      (sub.googleListing?.locationName ?? null) !== expect.locationName ||
      expect.classify(sub) !== expect.skipReason
    ) {
      return { ok: false, reason: "listing_changed" } as const;
    }
    const state = snap.exists ? readState(snap.data()) : EMPTY;
    if (state.lease && state.lease.until > now.getTime()) {
      return { ok: false, reason: "already_running" } as const;
    }
    const lease = { runId, until: now.getTime() + LEASE_TTL_MS };
    tx.set(ref, { ...state, lease });
    return { ok: true, state: { ...state, lease }, sub } as const;
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
 * written nothing in that chunk) when it is not. Callers write each doc at
 * most once per call — the page commit renews the lease inside its own
 * state write.
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

export const MANUAL_COOLDOWN_MS = 60_000;

/**
 * "Sync now" is limited to one per minute per sub-account: true when this
 * call claimed the slot, false inside the cooldown. The claim lives in the sync state doc (merge), so a
 * cache clear resets it along with everything else.
 */
export async function claimManualSlot(subAccountId: string, now: Date): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(syncStatePath(subAccountId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists ? (readState(snap.data()).lastManualAt ?? null) : null;
    if (last !== null && now.getTime() - last < MANUAL_COOLDOWN_MS) return false;
    tx.set(ref, { lastManualAt: now.getTime() }, { merge: true });
    return true;
  });
}

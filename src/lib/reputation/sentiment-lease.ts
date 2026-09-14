import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * `subAccounts/{id}/private/sentimentLease` — the classifier's one-per-tenant
 * lease, the Analyse-now cooldown, the pending hint and the last run's counts.
 *
 *   runId, until      the lease (5 min, renewed by its OWNER before each AI call)
 *   lastManualAt      Analyse now, at most once a minute
 *   pending           items a later run may still act on; null/absent = unknown
 *   lastRun           {classified, skipped, failed, at} of the last run that ran
 */

export const SENTIMENT_LEASE_TTL_MS = 5 * 60_000;
export const SENTIMENT_MANUAL_COOLDOWN_MS = 60_000;

export const sentimentLeasePath = (subAccountId: string) => `subAccounts/${subAccountId}/private/sentimentLease`;

export interface LeaseDoc {
  runId?: string | null;
  until?: number;
  lastManualAt?: number | null;
  pending?: number | null;
  lastRun?: { classified: number; skipped: number; failed: number; at: unknown } | null;
}

const ref = (sa: string) => getAdminDb().doc(sentimentLeasePath(sa));
const heldByOther = (d: LeaseDoc | undefined, runId: string, now: number) =>
  !!d?.runId && d.runId !== runId && (d.until ?? 0) > now;

export async function readLeaseDoc(sa: string): Promise<LeaseDoc> {
  return ((await ref(sa).get()).data() as LeaseDoc | undefined) ?? {};
}

/** Take the lease unless another run holds it unexpired. */
export async function acquireSentimentLease(sa: string, runId: string, now: number): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(ref(sa))).data() as LeaseDoc | undefined;
    if (heldByOther(d, runId, now)) return false;
    tx.set(ref(sa), { runId, until: now + SENTIMENT_LEASE_TTL_MS }, { merge: true });
    return true;
  });
}

/** Extend the lease — ONLY while it is still this run's (an expired one another run took is lost). */
export async function renewSentimentLease(sa: string, runId: string, now: number): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(ref(sa))).data() as LeaseDoc | undefined;
    if (d?.runId !== runId) return false;
    tx.set(ref(sa), { until: now + SENTIMENT_LEASE_TTL_MS }, { merge: true });
    return true;
  });
}

/**
 * Analyse now: the lease AND the 1/min slot in one transaction, so a press
 * refused as busy does not burn the cooldown.
 */
export async function startManualSentiment(
  sa: string,
  runId: string,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: "busy" | "too_soon" }> {
  return getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(ref(sa))).data() as LeaseDoc | undefined;
    if (heldByOther(d, runId, now)) return { ok: false, reason: "busy" } as const;
    if (typeof d?.lastManualAt === "number" && now - d.lastManualAt < SENTIMENT_MANUAL_COOLDOWN_MS) {
      return { ok: false, reason: "too_soon" } as const;
    }
    tx.set(ref(sa), { runId, until: now + SENTIMENT_LEASE_TTL_MS, lastManualAt: now }, { merge: true });
    return { ok: true } as const;
  });
}

/** Release (only if still ours), recording what is left for later and — when it ran — its counts. */
export async function releaseSentimentLease(
  sa: string,
  runId: string,
  after: { pending: number | null; lastRun?: LeaseDoc["lastRun"] },
): Promise<void> {
  try {
    await getAdminDb().runTransaction(async (tx) => {
      const d = (await tx.get(ref(sa))).data() as LeaseDoc | undefined;
      if (d?.runId !== runId) return;
      tx.set(ref(sa), { runId: null, until: 0, pending: after.pending, ...(after.lastRun ? { lastRun: after.lastRun } : {}) }, { merge: true });
    });
  } catch (err) {
    console.warn(`[reputation/sentiment] sa=${sa} lease not released kind=${err instanceof Error ? err.name : typeof err}`);
  }
}

/** The pending hint goes back to "unknown" (a skipped run cannot say what is left) — one read, a write only if needed. */
export async function markPendingUnknown(sa: string): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const d = (await tx.get(ref(sa))).data() as LeaseDoc | undefined;
    if (d && d.pending === null) return;
    if (!d) return; // absent already reads as unknown
    tx.set(ref(sa), { pending: null }, { merge: true });
  });
}

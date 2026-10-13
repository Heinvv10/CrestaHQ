import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { webVoiceUsagePath, type WebVoiceUsageDoc } from "@/types/web-voice";

/**
 * The `private/webVoiceUsage` doc's shape rules, shared by the accounting
 * (`web-voice-usage.ts`) and the reconciliation against ElevenLabs
 * (`web-voice-reconcile.ts`). Every writer reads the doc through
 * `normalise`, inside its transaction.
 */

/** A grant is claimable — and counts against concurrency and the cap as a
 *  grant — for exactly this long. After it, it lapses and is charged. */
export const GRANT_LIVE_MS = 2 * 60 * 1000;
/** ElevenLabs' signed-URL lifetime: a grant's call starts within it. */
export const SIGNED_URL_MS = 15 * 60 * 1000;
/** Clock skew allowed between our issue time and ElevenLabs' start time. */
export const START_SKEW_MS = 30 * 1000;
/** Counted-conversation ring size (dedupe for /end and reconciliation). */
const SETTLED_RING = 500;

/** The only form of a caught error this feature logs: never the object. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
export function utcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** `rec[key]` only when it is the record's own entry — never an inherited
 *  `Object.prototype` member named by a caller-supplied id. */
export function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Whether a call ElevenLabs reports as started at `startUnixSecs` can be the
 *  call of a grant issued at `grantIssuedAtMs`. Unknown start = no. */
export function startedAfterGrant(startUnixSecs: number | null, grantIssuedAtMs: number): boolean {
  return startUnixSecs !== null && startUnixSecs * 1000 >= grantIssuedAtMs - START_SKEW_MS;
}

const nonNegative = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/** Add seconds to today's and this month's counters (never below zero). */
export function addSeconds(u: WebVoiceUsageDoc, seconds: number): void {
  u.secondsToday = Math.max(0, u.secondsToday + seconds);
  u.secondsThisMonth = Math.max(0, u.secondsThisMonth + seconds);
}

/** Record conversation ids as counted. */
export function markSettled(u: WebVoiceUsageDoc, ids: string[]): void {
  u.settled = [...u.settled, ...ids].slice(-SETTLED_RING);
}

/**
 * Normalise a stored doc: roll the day/month counters over, then lapse every
 * grant past `GRANT_LIVE_MS` — removed from `grants`, its full reservation
 * charged to today's counters, and kept in `lapsed` until reconciliation
 * finds the call it paid for (or finds none and refunds it). On a read-only
 * path the charge is only computed; the next transaction persists it.
 */
export function normalise(raw: Partial<WebVoiceUsageDoc> | undefined): WebVoiceUsageDoc {
  const day = utcDay();
  const month = utcMonth();
  const u: WebVoiceUsageDoc = {
    day,
    secondsToday: 0,
    month,
    secondsThisMonth: 0,
    ...(raw ?? {}),
    pending: { ...(raw?.pending ?? {}) },
    grants: { ...(raw?.grants ?? {}) },
    lapsed: { ...(raw?.lapsed ?? {}) },
    settled: Array.isArray(raw?.settled) ? [...raw.settled] : [],
  };
  u.secondsToday = nonNegative(u.secondsToday);
  u.secondsThisMonth = nonNegative(u.secondsThisMonth);
  if (u.day !== day) {
    u.day = day;
    u.secondsToday = 0;
  }
  if (u.month !== month) {
    u.month = month;
    u.secondsThisMonth = 0;
  }
  const now = Date.now();
  for (const [id, grant] of Object.entries(u.grants)) {
    const issuedAtMs = nonNegative(grant?.issuedAtMs);
    if (now - issuedAtMs <= GRANT_LIVE_MS) continue;
    const chargedSeconds = nonNegative(grant?.seconds);
    delete u.grants[id];
    addSeconds(u, chargedSeconds);
    u.lapsed[id] = { issuedAtMs, day, month, chargedSeconds };
  }
  return u;
}

export async function readUsage(subAccountId: string): Promise<WebVoiceUsageDoc> {
  const snap = await getAdminDb().doc(webVoiceUsagePath(subAccountId)).get();
  return normalise(snap.data() as Partial<WebVoiceUsageDoc> | undefined);
}

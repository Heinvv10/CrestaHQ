/**
 * Review sync — the Firestore model and the run record.
 *
 *   subAccounts/{id}/gbpReviews/{docId}      cached reviews of the CURRENT listing
 *   subAccounts/{id}/gbpSyncRuns/{runId}     append-only, one per run, created at its end
 *   subAccounts/{id}/private/gbpSyncState    lease + pass cursor (locked)
 *   subAccounts/{id}.gbpSummary              member-readable summary — kinds only
 *
 * No client Firestore rules: every read is an API route on the Admin SDK and
 * the new subcollections fall under default deny.
 */

export type SyncTrigger = "manual" | "scheduled";
export type SyncStatus = "success" | "partial" | "failed" | "reconnect_required" | "skipped";
export type SkipReason =
  | "gate_off"
  | "not_connected"
  | "no_listing"
  | "reconnect_required"
  | "already_running";
/** `deferred` = this run did not reconcile (not a full pass, or it stopped early). */
export type Reconciliation = "full" | "deferred" | "skipped_anomaly";
export type GbpHealth = "ok" | "stale" | "partial" | "reconnect_required" | "error" | "never_synced";

/** Google's scheduled sync cadence (the QStash schedule is `0 *\/6 * * *`). */
export const CADENCE_MS = 6 * 3600_000;
/** Older than two missed cadences reads as stale, whatever the last run said. */
export const STALE_AFTER_MS = 2 * CADENCE_MS;
/** GBP content policy: cached content is kept no more than 30 calendar days. */
export const RETENTION_MS = 30 * 24 * 3600_000;
export const LEASE_TTL_MS = 5 * 60_000;
/** A pass older than this is abandoned and a new one starts from page 1. */
export const PASS_MAX_AGE_MS = 24 * 3600_000;
/** 20 pages × 50 = 1000 reviews per run. */
export const DEFAULT_MAX_PAGES = 20;

export interface SyncRunRecord {
  runId: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string | null;
  trigger: SyncTrigger;
  actorUid: string | null;
  startedAt: Date;
  finishedAt: Date;
  locationName: string | null;
  status: SyncStatus;
  pagesFetched: number;
  reviewsSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  purged: number;
  reconciliation: Reconciliation;
  resumedFromCursor: boolean;
  /** A provider error kind, `internal`, `retention_expired`, `lease_lost` — never a message. */
  errorKind: string | null;
  skipReason: SkipReason | null;
}

export interface GbpSummary {
  locationName: string;
  averageRating: number | null;
  totalReviewCount: number | null;
  lastSuccessfulSyncAt: Date | null;
  lastRunAt: Date;
  lastRunStatus: SyncStatus;
  lastErrorKind: string | null;
  health: GbpHealth;
}

export interface SyncState {
  lease: { runId: string; until: number } | null;
  pass: { passId: string; pageToken: string | null; pagesDone: number; startedAt: number } | null;
}

export interface GbpReviewDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: string | null;
  locationName: string;
  reviewName: string;
  reviewId: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean } | null;
  starRating: number;
  comment: string | null;
  createTime: Date;
  updateTime: Date;
  reply: { comment: string; updateTime: string } | null;
  state: "active" | "removed";
  firstSeenAt: Date;
  lastSeenAt: Date;
  removedAt: Date | null;
  passId: string;
  contentHash: string | null;
}

export const reviewsCollection = (sa: string) => `subAccounts/${sa}/gbpReviews`;
export const runsCollection = (sa: string) => `subAccounts/${sa}/gbpSyncRuns`;
export const syncStatePath = (sa: string) => `subAccounts/${sa}/private/gbpSyncState`;

/** Firestore returns Timestamps, tests hand back Dates; both become epoch ms. */
export function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

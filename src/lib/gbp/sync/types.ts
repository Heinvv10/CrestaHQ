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
  | "already_running"
  /** The listing / connection / gate changed between the run's read and its lease. */
  | "listing_changed"
  /** Housekeeping: Google's 30-day rule only, no provider call (retainListing). */
  | "retention_only";
/**
 * `full` = a complete pass that ran in ONE run: it counted a miss for every
 * active review it did not see and tombstoned those missed twice in a row.
 * `deferred` = no misses counted (the pass is not complete yet, or it was
 * resumed across runs). `skipped_anomaly` = a complete pass whose planned
 * tombstones look like an outage, held back; `full_after_anomaly` = the same
 * tombstones confirmed by the third such pass, each at least an hour apart.
 */
export type Reconciliation = "full" | "deferred" | "skipped_anomaly" | "full_after_anomaly";
export type GbpHealth =
  | "ok"
  | "stale"
  | "partial"
  | "reconnect_required"
  /** The last run needed a reconnect, and the connection has since been reconnected. */
  | "sync_pending"
  | "error"
  | "never_synced";

/** Google's scheduled sync cadence (the QStash schedule is `0 *\/6 * * *`). */
export const CADENCE_MS = 6 * 3600_000;
/** Older than two missed cadences reads as stale, whatever the last run said. */
export const STALE_AFTER_MS = 2 * CADENCE_MS;
/** GBP content policy: cached content is kept no more than 30 calendar days. */
export const RETENTION_MS = 30 * 24 * 3600_000;
export const LEASE_TTL_MS = 5 * 60_000;
/**
 * A pass older than this is abandoned and a new one starts from page 1. Long
 * enough for a big listing to finish over many 6-hourly runs; the per-review
 * 30-day rule still enforces the content policy meanwhile.
 */
export const PASS_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Consecutive complete passes with the same anomaly before its removals are applied. */
export const ANOMALY_CONFIRMATIONS = 3;
/** Anomaly confirmations closer together than this do not count (Sync now presses). */
export const ANOMALY_CONFIRMATION_GAP_MS = 3600_000;
/** Consecutive complete single-run passes a review must be missing from before it is tombstoned. */
export const MISSES_TO_REMOVE = 2;
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
  /** `running`: the cache marker stamped by a first run that has not finished yet. */
  lastRunStatus: SyncStatus | "running";
  lastErrorKind: string | null;
  /** The last run's reconciliation — tells a partial banner why. */
  lastReconciliation?: Reconciliation | null;
  health: GbpHealth;
}

export interface SyncPass {
  passId: string;
  pageToken: string | null;
  pagesDone: number;
  startedAt: number;
  /** First non-null values Google reported in this pass — never overwritten by a later null. */
  averageRating?: number | null;
  totalReviewCount?: number | null;
}

export interface SyncState {
  lease: { runId: string; until: number } | null;
  pass: SyncPass | null;
  /** When retention last purged everything (30 days without success); restarts the clock. */
  retentionPurgedAt?: number | null;
  /** The same planned removal count seen by consecutive anomalous complete passes. */
  anomalyStreak?: { removals: number; count: number; lastAt: number } | null;
  /** Last manual "Sync now" (epoch ms) — the 60s cooldown. */
  lastManualAt?: number | null;
}

export interface GbpReviewDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: string | null;
  locationName: string;
  reviewName: string;
  reviewId: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean } | null;
  /** Null on a tombstone. */
  starRating: number | null;
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
  /** Consecutive complete single-run passes this review was missing from (0 when seen). */
  missedPasses: number;
  /** Sticky: the review has had a reply at some point (auto-reply never replaces one). */
  hadReply?: boolean;
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

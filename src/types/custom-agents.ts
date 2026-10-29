import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Agent monitors: background agents that watch the CRM and only ever ADD
 * internal items (a Task, a push, an activity row, a dedupe stamp).
 *
 * One doc per agent at top-level `customAgents/{docId}`, so the hourly sweep
 * is a plain where("enabled") query with no collection-group index. The inbox
 * watchdog keeps its original id (= the sub-account id) and reads as
 * `type: "inbox-watchdog"` when the field is absent; every later agent uses
 * `{subAccountId}_{type}`. Server-only; runs log under `customAgents/{id}/runs`.
 */

export type AgentType = "inbox-watchdog" | "stale-deals";

export function agentDocId(subAccountId: string, type: AgentType): string {
  return type === "inbox-watchdog" ? subAccountId : `${subAccountId}_${type}`;
}

export interface WatchdogQuietHours {
  /** Local hour 0-23. */
  startHour: number;
  /** Local hour 0-23. Overnight windows (22 to 7) work. */
  endHour: number;
  /** IANA zone. */
  timezone: string;
}

/** Fields every agent doc carries. */
export interface AgentConfigBase {
  subAccountId: string;
  agencyId: string;
  /** Absent on the original watchdog doc = "inbox-watchdog". */
  type?: AgentType;
  /** Off by default; admin opts in. */
  enabled: boolean;
  /** Extra criteria passed verbatim to the model, max 1000 chars. */
  instructions: string | null;
  /** Suppresses push only; the task is still created. */
  quietHours: WatchdogQuietHours | null;
  /** Per UTC day. Runs skip once exceeded. */
  dailyTokenBudget: number;
  /** UTC YYYY-MM-DD that tokensToday counts for. */
  tokensTodayDate: string | null;
  tokensToday: number;
  totalTokensUsed: number;
  createdAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

export interface WatchdogConfigDoc extends AgentConfigBase {
  /** Hours an inbound conversation can sit unanswered before judging (1-24). */
  thresholdHours: number;
}

export interface StaleDealsConfigDoc extends AgentConfigBase {
  /** Days a deal may sit in one non-terminal stage before it is flagged (3-60). */
  thresholdDays: number;
  /** Null = every pipeline. "default" is allowed. */
  pipelineIds: string[] | null;
  /** `${pipelineId}:${stageId}` keys never flagged (e.g. a Parked stage). */
  excludeStageKeys: string[];
  /**
   * Where the next sweep resumes in the (stageChangedAt, doc id) order, so
   * deals it can never flag don't pin the window. Null = from the oldest.
   * Server-written by the sweep only.
   */
  scanCursor?: { stageChangedAtMs: number; dealId: string } | null;
}

export const WATCHDOG_DEFAULT_THRESHOLD_HOURS = 3;
export const WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET = 20_000;
/** Max LLM judgments per sweep run (cost ceiling). */
export const WATCHDOG_MAX_JUDGMENTS_PER_RUN = 20;

export const STALE_DEALS_DEFAULT_THRESHOLD_DAYS = 7;
export const STALE_DEALS_MIN_THRESHOLD_DAYS = 3;
export const STALE_DEALS_MAX_THRESHOLD_DAYS = 60;
export const STALE_DEALS_DEFAULT_DAILY_TOKEN_BUDGET = 10_000;
/** Max deals flagged per sweep run. */
export const STALE_DEALS_MAX_FLAGS_PER_RUN = 20;

export type WatchdogRunStatus = "completed" | "skipped" | "failed";

/**
 * The inbox watchdog keeps its Labs + AI Suite gates (`labs_gate_off`,
 * `ai_gate_off`); only the stale deals monitor reads `agentsEnabledByAgency`
 * (`agents_gate_off`).
 */
export type WatchdogSkippedReason =
  | "labs_gate_off"
  | "ai_gate_off"
  | "agents_gate_off"
  | "ai_not_configured"
  | "budget_exceeded";

export interface WatchdogRunAction {
  contactId: string;
  contactName: string;
  taskId: string;
  /** Max 140 chars. */
  reason: string;
  urgency: "high" | "normal";
  /** Stale-deals runs only. */
  dealId?: string;
  dealTitle?: string;
}

export interface WatchdogRunDoc {
  status: WatchdogRunStatus;
  skippedReason: WatchdogSkippedReason | null;
  /** Matched the pre-filter. */
  scanned: number;
  /** Dropped by the per-run cap. */
  droppedByCap: number;
  /** LLM calls made. */
  judged: number;
  flagged: number;
  actions: WatchdogRunAction[];
  tokensUsed: number;
  error: string | null;
  startedAt: Timestamp | FieldValue | Date | null;
  finishedAt: Timestamp | FieldValue | Date | null;
}

/** Config API wire shapes; timestamps are ISO strings. */
export interface WatchdogConfigResponse {
  enabled: boolean;
  thresholdHours: number;
  instructions: string | null;
  quietHours: WatchdogQuietHours | null;
  dailyTokenBudget: number;
  totalTokensUsed: number;
}

export interface StaleDealsConfigResponse {
  enabled: boolean;
  thresholdDays: number;
  pipelineIds: string[] | null;
  excludeStageKeys: string[];
  instructions: string | null;
  quietHours: WatchdogQuietHours | null;
  dailyTokenBudget: number;
  totalTokensUsed: number;
}

export interface WatchdogRunResponse {
  id: string;
  status: WatchdogRunStatus;
  skippedReason: WatchdogSkippedReason | null;
  scanned: number;
  judged: number;
  flagged: number;
  actions: WatchdogRunAction[];
  tokensUsed: number;
  startedAt: string | null;
  finishedAt: string | null;
}

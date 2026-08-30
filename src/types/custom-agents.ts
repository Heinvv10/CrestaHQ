import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Custom Agents v1 — the Inbox Follow-up Watchdog (Labs).
 * Full locked scope: CUSTOM_AGENTS_V1_PLAN.md (repo root).
 *
 * Storage: ONE agent doc per sub-account at top-level
 * `customAgents/{subAccountId}` (doc id == subAccountId). Top-level rather
 * than a subcollection so the hourly sweep's fan-out is a plain
 * `where("enabled", "==", true)` query — no collection-group index, and the
 * collection stays server-only (default-deny rules; the UI reads config +
 * runs through the admin API). Runs log at `customAgents/{said}/runs/{id}`.
 */

export interface WatchdogQuietHours {
  /** 0–23 local hour the quiet window starts (push suppressed). */
  startHour: number;
  /** 0–23 local hour it ends. Overnight windows (22 → 7) supported. */
  endHour: number;
  /** IANA timezone the window is evaluated in. */
  timezone: string;
}

export interface WatchdogConfigDoc {
  /** == doc id. Denormalized for serialization. */
  subAccountId: string;
  agencyId: string;
  /** Master switch. Default false — the workspace admin opts in. */
  enabled: boolean;
  /** Hours an inbound conversation may sit unanswered before judging. 1–24. */
  thresholdHours: number;
  /**
   * Optional operator criteria fed verbatim to the LLM judge (≤1000 chars),
   * e.g. "prioritise anything mentioning price or cancellation".
   */
  instructions: string | null;
  /** Suppresses PUSH inside the window; the Task is still created. */
  quietHours: WatchdogQuietHours | null;
  /** Judge-token budget per UTC day; the run skips once exceeded. */
  dailyTokenBudget: number;
  /** UTC YYYY-MM-DD the `tokensToday` counter belongs to. */
  tokensTodayDate: string | null;
  tokensToday: number;
  /** Lifetime counter (mirrors the AI channel docs' totalTokensUsed). */
  totalTokensUsed: number;
  createdAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

export const WATCHDOG_DEFAULT_THRESHOLD_HOURS = 3;
export const WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET = 20_000;
/** Max LLM judgments per sweep run (cost ceiling). */
export const WATCHDOG_MAX_JUDGMENTS_PER_RUN = 20;

export type WatchdogRunStatus = "completed" | "skipped" | "failed";

export type WatchdogSkippedReason =
  | "labs_gate_off"
  | "ai_gate_off"
  | "ai_not_configured"
  | "budget_exceeded";

export interface WatchdogRunAction {
  contactId: string;
  contactName: string;
  taskId: string;
  /** The judge's one-line reason (≤140 chars). */
  reason: string;
  urgency: "high" | "normal";
}

export interface WatchdogRunDoc {
  status: WatchdogRunStatus;
  skippedReason: WatchdogSkippedReason | null;
  /** Conversations matching the deterministic pre-filter. */
  scanned: number;
  /** Shortlist entries dropped by the per-run judgment cap. */
  droppedByCap: number;
  /** LLM calls actually made. */
  judged: number;
  /** Judged true → alerted. */
  flagged: number;
  actions: WatchdogRunAction[];
  tokensUsed: number;
  error: string | null;
  startedAt: Timestamp | FieldValue | Date | null;
  finishedAt: Timestamp | FieldValue | Date | null;
}

/** Wire shapes for the config API (timestamps → ISO strings). */
export interface WatchdogConfigResponse {
  enabled: boolean;
  thresholdHours: number;
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

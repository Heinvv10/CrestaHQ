/**
 * A Vapi end-of-call report → the mystery-shop outcome. Pure.
 *
 * Answered = a person picked up AND said something: the call did not end as
 * voicemail, no-answer, busy or a failure, and the transcript has a user
 * turn. A silence timeout before anyone spoke is not answered. A call that is
 * not answered leaves the shop waiting; an inbound call from the target number
 * inside the window then counts as the response (a callback).
 *
 * The time of answer: Vapi reports no separate "answered" timestamp, so it is
 * the report's `startedAt` when present (the call going in-progress), else
 * `endedAt − duration`, else (no timestamps at all) the time the report
 * arrived − duration. `basis` records which one was used.
 */

export interface CallReport {
  endedReason: string | null;
  durationSec: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** When the end-of-call report reached us. */
  receivedAtMs: number;
  /** The transcript has at least one turn by the person called. */
  userSpoke: boolean;
}

export type NotAnsweredReason = "voicemail" | "no_answer" | "busy" | "failed" | "no_speech";

export type CallOutcome =
  | { answered: true; atMs: number; basis: "startedAt" | "endedAt" | "receivedAt" }
  | { answered: false; reason: NotAnsweredReason };

export function notAnsweredReason(endedReason: string | null): NotAnsweredReason | null {
  const r = (endedReason ?? "").toLowerCase();
  if (r.includes("voicemail")) return "voicemail";
  if (/no-?answer|did-not-answer|not-answer/.test(r)) return "no_answer";
  if (r.includes("busy")) return "busy";
  if (/fail|error|reject|cancel|provider-closed/.test(r)) return "failed";
  return null;
}

/** When the call started: see the file comment for the fallbacks. */
export function callStartedAt(report: CallReport): { atMs: number; basis: "startedAt" | "endedAt" | "receivedAt" } {
  const durationMs = Math.max(0, report.durationSec) * 1000;
  if (report.startedAtMs !== null) return { atMs: report.startedAtMs, basis: "startedAt" };
  if (report.endedAtMs !== null) return { atMs: report.endedAtMs - durationMs, basis: "endedAt" };
  return { atMs: report.receivedAtMs - durationMs, basis: "receivedAt" };
}

export function callOutcome(report: CallReport): CallOutcome {
  const reason = notAnsweredReason(report.endedReason);
  if (reason) return { answered: false, reason };
  if (!report.userSpoke) return { answered: false, reason: "no_speech" };
  return { answered: true, ...callStartedAt(report) };
}

/** ISO string → ms, or null. */
export function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

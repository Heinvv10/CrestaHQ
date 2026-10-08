/**
 * A Vapi end-of-call report → the mystery-shop outcome. Pure.
 *
 * Answered = a person picked up and spoke: the call did not end as voicemail,
 * no-answer, busy or a failure; someone said something AFTER our opening line
 * (by `secondsFromStart`, else by transcript order); and nothing they said
 * sounds like a voicemail greeting or a phone menu ("leave a message", "press
 * 1", …). A silence timeout, or speech only before our opening, is not
 * answered. A call that is not answered leaves the shop waiting; an inbound
 * call from the target number inside the window then counts as the response
 * (a callback).
 *
 * The time of answer: Vapi reports no separate "answered" timestamp, so it is
 * the report's `startedAt` when present (the call going in-progress), else
 * `endedAt − duration`, else (no timestamps at all) the time the report
 * arrived − duration. `basis` records which one was used.
 */

export interface CallTurn {
  role: "assistant" | "user" | "system";
  content: string;
  secondsFromStart: number | null;
}

export interface CallReport {
  endedReason: string | null;
  durationSec: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** When the end-of-call report reached us. */
  receivedAtMs: number;
  /** The conversational turns, in transcript order. */
  turns: CallTurn[];
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

/** A voicemail greeting or a phone menu, not a person (en). */
const MACHINE =
  /leave (a|your) message|after the (tone|beep)|not available|voice ?mail|mailbox|press [0-9]|your call is important|office hours|please hold/i;

/** When the call started: see the file comment for the fallbacks. */
export function callStartedAt(report: CallReport): { atMs: number; basis: "startedAt" | "endedAt" | "receivedAt" } {
  const durationMs = Math.max(0, report.durationSec) * 1000;
  if (report.startedAtMs !== null) return { atMs: report.startedAtMs, basis: "startedAt" };
  if (report.endedAtMs !== null) return { atMs: report.endedAtMs - durationMs, basis: "endedAt" };
  return { atMs: report.receivedAtMs - durationMs, basis: "receivedAt" };
}

/** Did the person called speak after our opening line? */
function repliedAfterOpening(turns: CallTurn[]): boolean {
  const first = turns.findIndex((t) => t.role === "assistant");
  if (first === -1) return false;
  const opening = turns[first].secondsFromStart;
  return turns.some((t, i) => {
    if (t.role !== "user" || !t.content.trim()) return false;
    return opening !== null && t.secondsFromStart !== null ? t.secondsFromStart > opening : i > first;
  });
}

export function callOutcome(report: CallReport): CallOutcome {
  const reason = notAnsweredReason(report.endedReason);
  if (reason) return { answered: false, reason };
  if (report.turns.some((t) => t.role === "user" && MACHINE.test(t.content))) return { answered: false, reason: "voicemail" };
  if (!repliedAfterOpening(report.turns)) return { answered: false, reason: "no_speech" };
  return { answered: true, ...callStartedAt(report) };
}

/** ISO string → ms, or null. */
export function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

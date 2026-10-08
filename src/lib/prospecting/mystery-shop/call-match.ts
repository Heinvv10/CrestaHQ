/**
 * A Vapi end-of-call report → the mystery-shop outcome. Pure.
 *
 * Answered = the callee spoke AFTER our opening line (by `secondsFromStart`,
 * else by transcript order) and it was not a machine. A machine is a callee
 * whose FIRST turn is a clear voicemail / phone-menu phrase ("leave a message
 * after the tone", "press 1 for …") with no exchange after it (no callee turn
 * following an assistant turn that followed that first turn) — a menu that
 * leads to a person is answered. A dialogue is answered whatever the
 * endedReason: our own pipeline errors must never become the business's
 * miss. Only voicemail / no-answer / busy / failed WITHOUT a dialogue, a
 * silence timeout, or speech only before our opening (a "Hello?" then a
 * hang-up) is not answered. A call that is not answered leaves the shop
 * waiting; an inbound call from the target number inside the window then
 * counts as the response (a callback).
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

/** Clear voicemail / phone-menu phrasing (en). Words a person also says ("not available", "please hold") are left out. */
const MACHINE = /after the (tone|beep)|at the tone|voice ?mail|mailbox is full|press [0-9] for|record your message/i;

/** The callee's first turn is a machine phrase, and no exchange follows it. */
function machine(turns: CallTurn[]): boolean {
  const first = turns.findIndex((t) => t.role === "user" && t.content.trim());
  if (first === -1 || !MACHINE.test(turns[first].content)) return false;
  const reply = turns.findIndex((t, i) => i > first && t.role === "assistant");
  return reply === -1 || !turns.some((t, i) => i > reply && t.role === "user" && t.content.trim());
}

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
  const isMachine = machine(report.turns);
  if (repliedAfterOpening(report.turns) && !isMachine) return { answered: true, ...callStartedAt(report) };
  if (isMachine) return { answered: false, reason: "voicemail" };
  return { answered: false, reason: notAnsweredReason(report.endedReason) ?? "no_speech" };
}

/** ISO string → ms, or null. */
export function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

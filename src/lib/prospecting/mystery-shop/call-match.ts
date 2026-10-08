/**
 * A Vapi end-of-call report → the mystery-shop outcome. Pure.
 *
 * Answered = a real exchange: the callee spoke after our opening line (by
 * `secondsFromStart`, else by transcript order) AND a callee → assistant →
 * callee exchange follows the LAST callee turn that sounds like a machine
 * (voicemail greeting, phone menu: "you've reached", "leave your name and
 * number", "press 1 for …", Afrikaans "los 'n boodskap" …), or anywhere when
 * none does — whatever the endedReason, so our own pipeline errors after a
 * conversation never become the business's miss. A single callee turn is
 * ambiguous (a greeting we do not recognise could be a machine): not
 * answered, which leaves a miss for a member to check before it is public.
 * A call that is not answered leaves the shop waiting; an inbound call from
 * the target number inside the window then counts as the response.
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

export type NotAnsweredReason = "voicemail" | "no_answer" | "busy" | "failed" | "no_speech" | "no_exchange";

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

/** Clear voicemail / phone-menu phrasing (en, af). Words a person also says ("not available", "please hold") are left out. */
const MACHINE =
  /after the (tone|beep)|at the tone|voice ?mail|mailbox is full|press [0-9] for|record your message|leave (a|your) (message|name|number)|you(?:'|’)?ve reached|(can(?:'|’)?t|cannot|not able to) take your call|boodskap na die toon|los 'n boodskap/i;

const spoke = (t: CallTurn, role: CallTurn["role"]) => t.role === role && !!t.content.trim();

/** After index `from`: a callee turn, then an assistant turn, then a callee turn. */
function exchangeAfter(turns: CallTurn[], from: number): boolean {
  let i = from + 1;
  const next = (role: CallTurn["role"]) => {
    while (i < turns.length && !spoke(turns[i], role)) i++;
    return i++ < turns.length;
  };
  return next("user") && next("assistant") && next("user");
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
  const { turns } = report;
  const lastMachine = turns.findLastIndex((t) => spoke(t, "user") && MACHINE.test(t.content));
  const replied = repliedAfterOpening(turns);
  if (replied && exchangeAfter(turns, lastMachine)) return { answered: true, ...callStartedAt(report) };
  if (lastMachine !== -1) return { answered: false, reason: "voicemail" };
  return { answered: false, reason: notAnsweredReason(report.endedReason) ?? (replied ? "no_exchange" : "no_speech") };
}

/** ISO string → ms, or null. */
export function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

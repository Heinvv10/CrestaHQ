import { describe, expect, it } from "vitest";
import { callOutcome, callStartedAt, type CallReport, type CallTurn } from "./call-match";

const T0 = Date.parse("2026-10-08T08:00:00Z");
const bot = (s: number | null, content = "Hi, I'm calling from Cresta HQ. Do you do plumbing?"): CallTurn => ({
  role: "assistant", content, secondsFromStart: s,
});
const user = (s: number | null, content = "Yes we do, we can come tomorrow."): CallTurn => ({ role: "user", content, secondsFromStart: s });
const report = (extra: Partial<CallReport> = {}): CallReport => ({
  endedReason: "customer-ended-call",
  durationSec: 40,
  startedAtMs: T0 + 9_000,
  endedAtMs: T0 + 49_000,
  receivedAtMs: T0 + 60_000,
  turns: [bot(0.5), user(6)],
  ...extra,
});

describe("callOutcome", () => {
  it.each(["customer-ended-call", "assistant-ended-call", "assistant-said-end-call-phrase", "exceeded-max-duration", "silence-timed-out"])(
    "%s with a person replying after our opening is answered at startedAt",
    (endedReason) => {
      expect(callOutcome(report({ endedReason }))).toEqual({ answered: true, atMs: T0 + 9_000, basis: "startedAt" });
    },
  );

  it.each([
    ["voicemail", "voicemail"],
    ["customer-did-not-answer", "no_answer"],
    ["no-answer", "no_answer"],
    ["customer-busy", "busy"],
    ["twilio-failed-to-connect-call", "failed"],
    ["pipeline-error-openai-llm-failed", "failed"],
    ["vonage-rejected", "failed"],
    ["manually-canceled", "failed"],
    ["phone-call-provider-closed-websocket", "failed"],
  ])("%s is not answered (%s), even with a transcript", (endedReason, reason) => {
    expect(callOutcome(report({ endedReason }))).toEqual({ answered: false, reason });
  });

  it("no speech, or speech only before our opening, is not answered", () => {
    expect(callOutcome(report({ endedReason: "silence-timed-out", turns: [bot(0.5)] }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ turns: [user(0.2, "Hello?"), bot(1)] }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ turns: [user(6)] }))).toEqual({ answered: false, reason: "no_speech" });
    // Without timestamps the order of the turns decides.
    expect(callOutcome(report({ turns: [user(null, "Hello?"), bot(null)] }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ turns: [bot(null), user(null)] }))).toMatchObject({ answered: true });
  });

  it.each([
    "Hi, you've reached Acme Plumbing. Please leave a message after the tone.",
    "Leave your message after the beep",
    "The person you are calling is not available",
    "Welcome to the voicemail service",
    "The mailbox is full",
    "For sales press 1, for accounts press 2",
    "Your call is important to us",
    "Our office hours are eight to five",
    "Please hold while we connect you",
  ])("voicemail / IVR phrasing %j is not a person", (phrase) => {
    expect(callOutcome(report({ turns: [bot(0.5), user(3, phrase)] }))).toEqual({ answered: false, reason: "voicemail" });
    expect(callOutcome(report({ turns: [user(0.2, phrase), bot(4), user(9)] }))).toEqual({ answered: false, reason: "voicemail" });
  });
});

describe("callStartedAt", () => {
  it("prefers startedAt, then endedAt − duration, then received − duration", () => {
    expect(callStartedAt(report())).toEqual({ atMs: T0 + 9_000, basis: "startedAt" });
    expect(callStartedAt(report({ startedAtMs: null }))).toEqual({ atMs: T0 + 9_000, basis: "endedAt" });
    expect(callStartedAt(report({ startedAtMs: null, endedAtMs: null }))).toEqual({ atMs: T0 + 20_000, basis: "receivedAt" });
  });
});

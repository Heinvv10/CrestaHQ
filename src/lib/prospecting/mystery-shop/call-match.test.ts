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
  ])("%s with no dialogue is not answered (%s)", (endedReason, reason) => {
    expect(callOutcome(report({ endedReason, turns: [] }))).toEqual({ answered: false, reason });
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
    "Sorry, he's not available right now, can I take a message?",
    "Yes we do plumbing. Do you want to leave a message for the boss?",
    "Please hold, let me check the diary.",
    "Our office hours are eight to five, but yes we can come tomorrow.",
  ])("a person who says %j after our opening is answered", (phrase) => {
    expect(callOutcome(report({ turns: [bot(0.5), user(3, phrase)] }))).toMatchObject({ answered: true });
  });

  it("a phone menu followed by a real exchange is answered", () => {
    const turns = [user(0.2, "Welcome to Acme. Press 1 for sales, press 2 for accounts."), bot(4), user(9, "Hi, sales here, how can I help?")];
    expect(callOutcome(report({ turns }))).toMatchObject({ answered: true });
  });

  it.each([
    "You've reached ABC Plumbing, please leave a message after the tone.",
    "Please record your message after the beep",
    "The mailbox is full and cannot accept messages",
    "Welcome to the Vodacom voicemail service",
    "Press 1 for sales, press 2 for accounts",
  ])("a single machine greeting %j with no exchange is not answered", (phrase) => {
    expect(callOutcome(report({ turns: [bot(0.5), user(3, phrase)] }))).toEqual({ answered: false, reason: "voicemail" });
    expect(callOutcome(report({ turns: [user(0.2, phrase), bot(4)] }))).toEqual({ answered: false, reason: "voicemail" });
  });

  it("a callee who only says 'Hello?' before our opening, then hangs up, is not answered", () => {
    expect(callOutcome(report({ turns: [user(0.2, "Hello?"), bot(1)] }))).toEqual({ answered: false, reason: "no_speech" });
  });
});

describe("our own failures never become the business's miss", () => {
  it.each(["pipeline-error-openai-llm-failed", "phone-call-provider-closed-websocket", "assistant-error", "twilio-failed-to-connect-call", "voicemail", "customer-busy"])(
    "a dialogue ending %s is still answered",
    (endedReason) => {
      expect(callOutcome(report({ endedReason }))).toMatchObject({ answered: true });
    },
  );
  it.each([
    ["voicemail", "voicemail"],
    ["customer-did-not-answer", "no_answer"],
    ["customer-busy", "busy"],
    ["pipeline-error-openai-llm-failed", "failed"],
  ])("%s with no dialogue is not answered (%s)", (endedReason, reason) => {
    expect(callOutcome(report({ endedReason, turns: [bot(0.5)] }))).toEqual({ answered: false, reason });
  });
});

describe("callStartedAt", () => {
  it("prefers startedAt, then endedAt − duration, then received − duration", () => {
    expect(callStartedAt(report())).toEqual({ atMs: T0 + 9_000, basis: "startedAt" });
    expect(callStartedAt(report({ startedAtMs: null }))).toEqual({ atMs: T0 + 9_000, basis: "endedAt" });
    expect(callStartedAt(report({ startedAtMs: null, endedAtMs: null }))).toEqual({ atMs: T0 + 20_000, basis: "receivedAt" });
  });
});

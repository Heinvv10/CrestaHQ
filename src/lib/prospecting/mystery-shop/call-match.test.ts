import { describe, expect, it } from "vitest";
import { callOutcome, callStartedAt, type CallReport } from "./call-match";

const T0 = Date.parse("2026-10-08T08:00:00Z");
const report = (extra: Partial<CallReport> = {}): CallReport => ({
  endedReason: "customer-ended-call",
  durationSec: 40,
  startedAtMs: T0 + 9_000,
  endedAtMs: T0 + 49_000,
  receivedAtMs: T0 + 60_000,
  userSpoke: true,
  ...extra,
});

describe("callOutcome", () => {
  it.each(["customer-ended-call", "assistant-ended-call", "assistant-said-end-call-phrase", "exceeded-max-duration", "silence-timed-out"])(
    "%s with speech is answered at startedAt",
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

  it("a silence timeout before anyone spoke is not answered; so is a pick-up with no speech", () => {
    expect(callOutcome(report({ endedReason: "silence-timed-out", userSpoke: false }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ userSpoke: false }))).toEqual({ answered: false, reason: "no_speech" });
  });
});

describe("callStartedAt", () => {
  it("prefers startedAt, then endedAt − duration, then received − duration", () => {
    expect(callStartedAt(report())).toEqual({ atMs: T0 + 9_000, basis: "startedAt" });
    expect(callStartedAt(report({ startedAtMs: null }))).toEqual({ atMs: T0 + 9_000, basis: "endedAt" });
    expect(callStartedAt(report({ startedAtMs: null, endedAtMs: null }))).toEqual({ atMs: T0 + 20_000, basis: "receivedAt" });
  });
});

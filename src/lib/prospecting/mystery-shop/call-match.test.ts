import { describe, expect, it } from "vitest";
import { callOutcome, callStartedAt, type CallReport, type CallTurn } from "./call-match";

const T0 = Date.parse("2026-10-08T08:00:00Z");
const bot = (s: number | null, content = "Hi, I'm calling from Cresta HQ. Do you do plumbing?"): CallTurn => ({
  role: "assistant", content, secondsFromStart: s,
});
const user = (s: number | null, content = "Yes we do, we can come tomorrow."): CallTurn => ({ role: "user", content, secondsFromStart: s });
/** A real conversation: the callee answers, we reply, the callee answers again. */
const EXCHANGE = [bot(0.5), user(6, "Bob's Plumbing, hello?"), bot(8, "Do you do plumbing in Gqeberha?"), user(12)];
const report = (extra: Partial<CallReport> = {}): CallReport => ({
  endedReason: "customer-ended-call",
  durationSec: 40,
  startedAtMs: T0 + 9_000,
  endedAtMs: T0 + 49_000,
  receivedAtMs: T0 + 60_000,
  turns: EXCHANGE,
  ...extra,
});

describe("answered needs a real exchange: callee → assistant → callee after the last machine turn", () => {
  it.each(["customer-ended-call", "assistant-ended-call", "assistant-said-end-call-phrase", "exceeded-max-duration", "silence-timed-out", "voicemail"])(
    "an exchange ending %s is answered at startedAt",
    (endedReason) => {
      expect(callOutcome(report({ endedReason }))).toEqual({ answered: true, atMs: T0 + 9_000, basis: "startedAt" });
    },
  );

  it.each(["pipeline-error-openai-llm-failed", "phone-call-provider-closed-websocket", "assistant-error", "twilio-failed-to-connect-call", "customer-busy"])(
    "our own failure (%s) after an exchange never becomes the business's miss",
    (endedReason) => {
      expect(callOutcome(report({ endedReason }))).toMatchObject({ answered: true });
    },
  );

  it.each([
    "Sorry, he's not available right now, can I take a message?",
    "Yes we do plumbing. Do you want to leave a message for the boss?",
    "Please hold, let me check the diary.",
    "Our office hours are eight to five, but yes we can come tomorrow.",
    "Hello, Bob's Plumbing.",
  ])("a single callee turn %j is NOT answered — ambiguous, so it waits for a member's check", (phrase) => {
    expect(callOutcome(report({ turns: [bot(0.5), user(3, phrase)] }))).toMatchObject({ answered: false });
    expect(callOutcome(report({ turns: [bot(0.5), user(3, phrase)] })).answered).toBe(false);
  });

  it("a single plain callee turn is reported as no exchange", () => {
    expect(callOutcome(report({ turns: [bot(0.5), user(3, "Hello, Bob's Plumbing.")] }))).toEqual({ answered: false, reason: "no_exchange" });
  });

  it.each([
    "Sorry, he's not available right now, can I take a message?",
    "Please hold, let me check the diary.",
  ])("the same words inside a real exchange are answered: %j", (phrase) => {
    expect(callOutcome(report({ turns: [bot(0.5), user(3, phrase), bot(6), user(9, "Yes, tomorrow at 9.")] }))).toMatchObject({ answered: true });
  });

  it("a person who greets with \"you've reached\" and then talks with us is answered", () => {
    const turns = [
      user(0.2, "Good morning, you've reached Bob's Plumbing, Sarah speaking."), bot(3),
      user(7, "Yes, we can send someone at two. Bye."), bot(9, "Thank you, goodbye."),
    ];
    expect(callOutcome(report({ turns }))).toMatchObject({ answered: true });
  });

  it("a phone menu then a person is answered only when the person and we exchange", () => {
    const menu = user(0.2, "Welcome to Acme. Press 1 for sales, press 2 for accounts.");
    expect(callOutcome(report({ turns: [menu, bot(4), user(9, "Hi, sales here, how can I help?")] }))).toEqual({ answered: false, reason: "voicemail" });
    expect(callOutcome(report({ turns: [menu, bot(4), user(9, "Sales here."), bot(11), user(14, "Yes we can.")] }))).toMatchObject({ answered: true });
  });
});

describe("machines", () => {
  it.each([
    "You've reached ABC Plumbing, please leave a message after the tone.",
    "You've reached Joe's Plumbing, please leave your name and number and we'll get back to you.",
    "Hi, this is Joe's Plumbing. Leave your number and we'll call back.",
    "Please leave a message.",
    "Sorry, we can't take your call right now.",
    "We cannot take your call at the moment.",
    "I'm not able to take your call.",
    "Please record your message after the beep",
    "The mailbox is full and cannot accept messages",
    "Welcome to the Vodacom voicemail service",
    "Press 1 for sales, press 2 for accounts",
    "Jy het Bob se Loodgieters bereik, los asseblief 'n boodskap na die toon.",
    "Bob se Loodgieters, los 'n boodskap.",
  ])("%j is a machine greeting: not answered, even with a reply after it", (phrase) => {
    for (const endedReason of ["silence-timed-out", "customer-ended-call", "voicemail"]) {
      expect(callOutcome(report({ endedReason, turns: [bot(0.5), user(3, phrase)] }))).toEqual({ answered: false, reason: "voicemail" });
      expect(callOutcome(report({ endedReason, turns: [user(0.2, phrase), bot(4), user(8, "Thanks.")] }))).toEqual({ answered: false, reason: "voicemail" });
    }
  });

  it("the LAST machine turn decides: a menu, our reply, then a voicemail prompt is not answered", () => {
    const turns = [user(0.2, "Press 1 for sales, press 2 for accounts."), bot(3), user(6, "Please leave a message after the tone.")];
    expect(callOutcome(report({ turns }))).toEqual({ answered: false, reason: "voicemail" });
  });

  it("an exchange after an EARLIER machine turn does not count when a later machine turn ends the call", () => {
    const turns = [
      user(0.2, "Press 1 for sales, press 2 for accounts."), bot(3), user(6, "Sales, one moment."), bot(8),
      user(12, "Nobody is available, please leave a message after the tone."),
    ];
    expect(callOutcome(report({ turns }))).toEqual({ answered: false, reason: "voicemail" });
  });

  it("a 'voicemail of 082…' turn then a second greeting segment is not answered", () => {
    const turns = [user(0.2, "Voicemail of 082 123 4567."), bot(2), user(6, "Bob's Plumbing, nobody's here right now.")];
    expect(callOutcome(report({ endedReason: "voicemail", turns }))).toEqual({ answered: false, reason: "voicemail" });
  });
});

describe("no dialogue", () => {
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
    expect(callOutcome(report({ endedReason, turns: [bot(0.5)] }))).toEqual({ answered: false, reason });
  });

  it("no speech, or speech only before our opening, is not answered", () => {
    expect(callOutcome(report({ endedReason: "silence-timed-out", turns: [bot(0.5)] }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ turns: [user(0.2, "Hello?"), bot(1)] }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ turns: [user(6)] }))).toEqual({ answered: false, reason: "no_speech" });
    // Without timestamps the order of the turns decides.
    expect(callOutcome(report({ turns: [user(null, "Hello?"), bot(null)] }))).toEqual({ answered: false, reason: "no_speech" });
    expect(callOutcome(report({ turns: [bot(null), user(null), bot(null), user(null)] }))).toMatchObject({ answered: true });
  });
});

describe("callStartedAt", () => {
  it("prefers startedAt, then endedAt − duration, then received − duration", () => {
    expect(callStartedAt(report())).toEqual({ atMs: T0 + 9_000, basis: "startedAt" });
    expect(callStartedAt(report({ startedAtMs: null }))).toEqual({ atMs: T0 + 9_000, basis: "endedAt" });
    expect(callStartedAt(report({ startedAtMs: null, endedAtMs: null }))).toEqual({ atMs: T0 + 20_000, basis: "receivedAt" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/comms/ai/openrouter", () => ({ callAi: vi.fn(), aiIsConfigured: () => true, defaultAiModel: () => "m-default" }));

import { draftReplyWith, type BoundedCall } from "./openrouter-draft";
import { REVIEWS_AI_CALL_MS, type DraftInput } from "./types";

/**
 * The draft's voice (openrouter-draft.ts SYSTEM + slop.ts), through the real
 * draftReplyWith with a fake BoundedCall: a slop hit gets exactly ONE plainer
 * retry, and a second hit is no draft (`slop`), never text.
 */

const INPUT: DraftInput = {
  starRating: 4,
  comment: "Fixture technician was quick and tidy.",
  reviewerFirstName: "Sam",
  businessName: "Velo Test Fibre",
  guidelines: null,
};

const PROD_GUIDELINES =
  "No exclamation marks, no emojis, no dashes between clauses. Never use: thrilled, delighted, truly, genuinely, appreciate your support, don't hesitate, reach out, look forward to serving or welcoming you, earn that fifth star, valued customer.";
const SLOPPY = "We're thrilled. Don't hesitate to reach out, we truly appreciate your support as a valued customer.";

function fakeCall(...answers: string[]) {
  const call = vi.fn<BoundedCall>(async () => {
    const text = answers.shift();
    if (text === undefined) throw new Error("no more answers");
    return { text, model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  });
  return call;
}
const messagesOf = (call: ReturnType<typeof fakeCall>, i: number) => call.mock.calls[i][0].messages;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the voice rules in the prompt", () => {
  it("asks for 1-2 short sentences, a named opener, one specific detail, and bans the tells", async () => {
    const call = fakeCall("Thanks Sam. Glad the team was quick.");
    await draftReplyWith("m", INPUT, call);
    const system = messagesOf(call, 0)[0].content as string;
    for (const rule of [
      /1.2 short sentences/i, /rating-only.*one sentence/i, /Thanks \{first name\}\./, /one specific thing/i, /never invent/i,
      /exclamation/i, /emoji/i, /dash/i, /star rating/i, /look forward to/i, /hesitate/i, /sign-off/i, /guidelines.*win/i,
    ]) {
      expect(system).toMatch(rule);
    }
    expect(call.mock.calls[0][0].temperature).toBeLessThanOrEqual(0.5);
  });

  it("the example replies obey the voice check themselves", async () => {
    const { slopHit } = await import("./slop");
    const call = fakeCall("Thanks Sam. Glad the team was quick.");
    await draftReplyWith("m", INPUT, call);
    const system = messagesOf(call, 0)[0].content as string;
    const examples = [...system.matchAll(/^- "(.+)"$/gm)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const e of examples) expect(slopHit(e)).toBeNull();
  });
});

describe("the slop check", () => {
  it("a clean draft is returned after ONE call", async () => {
    const call = fakeCall("Thanks Sam. Glad the team was quick.");
    expect(await draftReplyWith("m", INPUT, call)).toEqual({ text: "Thanks Sam. Glad the team was quick." });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("slop then clean → the clean rewrite, exactly 2 calls; the retry names the rule and never repeats the review", async () => {
    const call = fakeCall("Thanks Sam! We're thrilled.", "Thanks Sam. Glad the team was quick.");
    expect(await draftReplyWith("m", INPUT, call)).toEqual({ text: "Thanks Sam. Glad the team was quick." });
    expect(call).toHaveBeenCalledTimes(2);
    const first = messagesOf(call, 0);
    const second = messagesOf(call, 1);
    // The same call plus ONE extra user message.
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second).toHaveLength(first.length + 1);
    const note = second[second.length - 1];
    expect(note.role).toBe("user");
    expect(note.content).toContain("exclamation");
    expect(note.content).not.toContain("thrilled");
    const all = JSON.stringify(second);
    expect(all.split(INPUT.comment!).length - 1).toBe(1);
  });

  it("slop then slop → no draft (`slop`), 2 calls, no text", async () => {
    const call = fakeCall("Thanks Sam — great.", "We truly appreciate your support.", "Thanks Sam. Glad it was quick.");
    expect(await draftReplyWith("m", INPUT, call)).toEqual({ text: null, failure: "slop" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("logs the rule id only, never review or draft text", async () => {
    const call = fakeCall("Fixture wow! Amazing.", "Fixture wow! Amazing again.");
    await draftReplyWith("m", INPUT, call);
    const logged = JSON.stringify((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).toContain("kind=slop");
    expect(logged).not.toMatch(/Fixture|Amazing|wow/);
  });

  it("an unsupplied contact is refused at once — no retry", async () => {
    const call = fakeCall("Thanks Sam. Call 082 123 4567.", "Thanks Sam.");
    expect(await draftReplyWith("m", INPUT, call)).toEqual({ text: null, failure: "unsupplied_contact" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("a failed retry call is call_failed", async () => {
    const call = fakeCall("Thanks Sam!");
    expect(await draftReplyWith("m", INPUT, call)).toEqual({ text: null, failure: "call_failed" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("the production guidelines name the tells they ban — a draft using them is still refused (guidelines only add bans)", async () => {
    const call = fakeCall(SLOPPY, SLOPPY, "unused");
    expect(await draftReplyWith("m", { ...INPUT, guidelines: PROD_GUIDELINES }, call)).toEqual({ text: null, failure: "slop" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("the retry note says the model's previous draft was rejected, naming the rule only", async () => {
    const call = fakeCall("Thanks Sam! Great.", "Thanks Sam. Glad the team was quick.");
    await draftReplyWith("m", INPUT, call);
    const note = messagesOf(call, 1).at(-1)!;
    expect(note.content).toBe("Write the reply again. Your previous draft was rejected for: exclamation. Keep it plain.");
  });

  it("the reviewer's first name and the business name are not tells", async () => {
    const call = fakeCall("Thanks Truly. Delighted Cleaning is glad the team was quick.");
    const out = await draftReplyWith("m", { ...INPUT, reviewerFirstName: "Truly", businessName: "Delighted Cleaning" }, call);
    expect(out).toEqual({ text: "Thanks Truly. Delighted Cleaning is glad the team was quick." });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("the retry and the caller's deadline", () => {
  it("no room left for a second bounded call before the deadline → no retry, `slop`", async () => {
    const call = fakeCall("Thanks Sam!", "Thanks Sam. Glad the team was quick.");
    const out = await draftReplyWith("m", INPUT, call, Date.now() + REVIEWS_AI_CALL_MS - 1_000);
    expect(out).toEqual({ text: null, failure: "slop" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("room for one more bounded call → the retry runs", async () => {
    const call = fakeCall("Thanks Sam!", "Thanks Sam. Glad the team was quick.");
    const out = await draftReplyWith("m", INPUT, call, Date.now() + REVIEWS_AI_CALL_MS + 5_000);
    expect(out).toEqual({ text: "Thanks Sam. Glad the team was quick." });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("the clock is read AFTER the first call: a slow first call uses up the room", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const call = vi.fn<BoundedCall>(async () => {
      now.mockReturnValue(t0 + 30_000);
      return { text: "Thanks Sam!", model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    });
    expect(await draftReplyWith("m", INPUT, call, t0 + REVIEWS_AI_CALL_MS + 10_000)).toEqual({ text: null, failure: "slop" });
    expect(call).toHaveBeenCalledTimes(1);
    now.mockRestore();
    now.mockRestore();
  });
});

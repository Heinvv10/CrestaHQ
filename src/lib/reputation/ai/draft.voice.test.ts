import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/comms/ai/openrouter", () => ({ callAi: vi.fn(), aiIsConfigured: () => true, defaultAiModel: () => "m-default" }));

import { draftReplyWith, type BoundedCall } from "./openrouter-draft";
import type { DraftInput } from "./types";

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

  it("a tell the guidelines themselves use is allowed", async () => {
    const call = fakeCall("Thanks Sam. Glad it was quick. Cheers! The Fixture Team");
    const out = await draftReplyWith("m", { ...INPUT, guidelines: "Sign off: Cheers! The Fixture Team" }, call);
    expect(out.text).toContain("Cheers!");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

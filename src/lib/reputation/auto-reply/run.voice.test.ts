import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-reply with the REAL draft seam (openrouter-draft.ts draftReplyWith)
 * over a fake model call: a draft that fails the voice check twice is never
 * posted — it is held for a person as `draft_failed` — and the retry is under
 * the same ONE auto-draft budget unit.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const model = vi.hoisted(() => ({ answers: [] as string[], calls: 0 }));
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  const { draftReplyWith } = await import("@/lib/reputation/ai/openrouter-draft");
  return {
    ...real,
    getReviewsAiFor: async (sa: string) => ({
      ...(await real.getReviewsAiFor(sa)),
      model: "m-voice",
      draftReply: (input: Parameters<typeof draftReplyWith>[1]) =>
        draftReplyWith("m-voice", input, async () => {
          model.calls += 1;
          // A runaway retry loop fails the test instead of hanging it.
          if (model.calls > 20) throw new Error("runaway retries");
          const text = model.answers.shift() ?? "Thank you so much for the fifth star!";
          return { text, model: "m-voice", promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        }),
    }),
  };
});

import { SA, mem } from "@/test/gbp-sync-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { pendingOf, posts, replyOf, resetAutoReply, syncAndRun } from "@/test/auto-reply-harness";
import { sentimentUsagePath } from "@/lib/reputation/sentiment-calls";
import { needsApproval } from "./approval";

beforeEach(() => {
  resetAutoReply();
  model.answers = [];
  model.calls = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const autoDraftCalls = () => (mem.read(sentimentUsagePath(SA)) as { autoDraftCalls?: number } | undefined)?.autoDraftCalls;

describe("auto-reply and the voice check", () => {
  it("a rating-only 5★ whose model answers slop twice is NOT posted and is held for a person", async () => {
    // Both eligible reviews (fake-a1 5★, fake-a2 4★, rating-only) get slop on every call.
    const run = await syncAndRun();
    expect(posts()).toEqual([]);
    expect(run).toMatchObject({ posted: 0, drafted: 0 });
    for (const id of ["fake-a1", "fake-a2"]) {
      expect(pendingOf(id)).toMatchObject({ reason: "draft_failed", text: null, textHash: null });
      expect(needsApproval(mem.read(reviewPath(id))!)).toBe(true);
    }
    // One retry each: 2 model calls per review, ONE budget unit per review.
    expect(model.calls).toBe(4);
    expect(autoDraftCalls()).toBe(2);
    const logged = JSON.stringify((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).toContain("kind=slop");
    expect(logged).not.toContain("fifth star");
  });

  it("slop then a clean rewrite → the clean rewrite is posted", async () => {
    model.answers = ["Thanks so much!", "Thanks for taking the time to rate us.", "Thanks for the rating.", "unused"];
    await syncAndRun();
    expect(posts()).toHaveLength(2);
    expect(replyOf("fake-a1")).toBe("Thanks for taking the time to rate us.");
    expect(replyOf("fake-a2")).toBe("Thanks for the rating.");
    expect(model.calls).toBe(3);
    expect(autoDraftCalls()).toBe(2);
  });
});

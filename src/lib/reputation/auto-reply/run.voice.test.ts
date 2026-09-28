import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-reply with the REAL draft seam (openrouter-draft.ts draftReplyWith)
 * over a fake model call: a draft that fails the voice check twice is never
 * posted — it is held for a person as `draft_failed` — and the retry is under
 * the same ONE auto-draft budget unit.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const DEFAULT_SLOP = "Thank you so much for the fifth star!";
const model = vi.hoisted(() => ({ answers: [] as string[], calls: 0, fallback: "" }));
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  const { draftReplyWith } = await import("@/lib/reputation/ai/openrouter-draft");
  return {
    ...real,
    getReviewsAiFor: async (sa: string) => ({
      ...(await real.getReviewsAiFor(sa)),
      model: "m-voice",
      draftReply: (input: Parameters<typeof draftReplyWith>[1], deadlineMs?: number) =>
        draftReplyWith("m-voice", input, async () => {
          model.calls += 1;
          // A runaway retry loop fails the test instead of hanging it.
          if (model.calls > 20) throw new Error("runaway retries");
          const text = model.answers.shift() ?? model.fallback;
          return { text, model: "m-voice", promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        }, deadlineMs),
    }),
  };
});

import { SA, mem } from "@/test/gbp-sync-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { patchSub, pendingOf, posts, putFixtureReview, replyOf, resetAutoReply, syncAndRun } from "@/test/auto-reply-harness";
import { REVIEWS_AI_CALL_MS } from "@/lib/reputation/ai/types";
import { autoReplyAlertsCollection } from "./alerts";
import { sentimentUsagePath } from "@/lib/reputation/sentiment-calls";
import { needsApproval } from "./approval";

const PROD_GUIDELINES =
  "No exclamation marks, no emojis, no dashes between clauses. Never use: thrilled, delighted, truly, genuinely, appreciate your support, don't hesitate, reach out, look forward to serving or welcoming you, earn that fifth star, valued customer.";
const SLOPPY = "We're thrilled. Don't hesitate to reach out, we truly appreciate your support as a valued customer.";
const heldAlerts = () => mem.list(autoReplyAlertsCollection(SA)).filter((a) => a.kind === "held");

beforeEach(() => {
  resetAutoReply();
  model.answers = [];
  model.calls = 0;
  model.fallback = DEFAULT_SLOP;
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

  it("the production guidelines ban the tells; a draft using them is never posted — held draft_failed", async () => {
    patchSub({ reviewsAiConfig: { replyGuidelines: PROD_GUIDELINES } });
    model.fallback = SLOPPY;
    await syncAndRun();
    expect(posts()).toEqual([]);
    expect(model.calls).toBe(4);
    for (const id of ["fake-a1", "fake-a2"]) expect(pendingOf(id)).toMatchObject({ reason: "draft_failed", text: null });
  });

  it("the run's deadline reaches the draft: no room for a second bounded call → no retry, held, never posted", async () => {
    await syncAndRun(Date.now() + REVIEWS_AI_CALL_MS - 5_000);
    expect(model.calls).toBe(2);
    expect(posts()).toEqual([]);
    for (const id of ["fake-a1", "fake-a2"]) expect(pendingOf(id)).toMatchObject({ reason: "draft_failed", text: null });
  });
});

describe("a review whose drafts keep failing the voice check", () => {
  it("over 3 days: two days of drafts, then none, and ONE held alert; new content drafts again", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      const perDay: number[] = [];
      for (let day = 0; day < 3; day++) {
        vi.setSystemTime(t0 + day * 25 * 3600_000);
        const before = model.calls;
        await syncAndRun();
        perDay.push(model.calls - before);
      }
      expect(perDay).toEqual([4, 4, 0]);
      expect(posts()).toEqual([]);
      for (const id of ["fake-a1", "fake-a2"]) {
        expect(pendingOf(id)).toMatchObject({ reason: "draft_failed", text: null });
        expect(needsApproval(mem.read(reviewPath(id))!)).toBe(true);
      }
      expect(heldAlerts()).toMatchObject([{ count: 2 }]);
      // The review's content changes → drafted again.
      putFixtureReview("fake-a1", 4, null, 28);
      vi.setSystemTime(t0 + 3 * 25 * 3600_000);
      const before = model.calls;
      await syncAndRun();
      expect(model.calls - before).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

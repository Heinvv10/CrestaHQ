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
          if (text === "__THROW__") throw new Error("call_failed_test");
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

const rawPendingOf = (id: string) => mem.read(reviewPath(id))?.pendingReply as { reason: string; slopFails?: number } | undefined;
// storePending omits `slopFails` from the write entirely when it is 0 (falsy) — so "0" reads as absent.
const slopFailsOf = (id: string) => rawPendingOf(id)?.slopFails ?? 0;

describe("slopFails resets when the review's content changes (run.ts, prior.basisHash === basisHash)", () => {
  it("capped at 2 on content A, then edited to content B: still redrafted (not capped), slopFails 1", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      await syncAndRun(); // day 0: first slop on content A
      expect(rawPendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", slopFails: 1 });

      vi.setSystemTime(t0 + 25 * 3600_000);
      await syncAndRun(); // day 1: second slop on content A → hits the cap, held for a person
      expect(rawPendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", slopFails: 2 });

      // Content changes: no wait needed (the pending draft is no longer "fresh" for the new basis).
      putFixtureReview("fake-a1", 4, null, 28);
      const before = model.calls;
      await syncAndRun();
      // Redrafted, not skipped as capped: one attempt + its one retry, both slop.
      expect(model.calls - before).toBe(2);
      expect(rawPendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", slopFails: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a retry skipped for the deadline does not count toward the cap", () => {
  it("two near-deadline runs give slopFails 0 and are not capped; a later run with time available retries", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const nearDeadline = () => Date.now() + REVIEWS_AI_CALL_MS - 5_000;
    try {
      await syncAndRun(nearDeadline()); // day 0: slop, no room for the retry → held_deadline, never counted
      expect(model.calls).toBe(2); // one attempt per eligible review, no retry
      for (const id of ["fake-a1", "fake-a2"]) {
        expect(rawPendingOf(id)).toMatchObject({ reason: "draft_failed" });
        expect(slopFailsOf(id)).toBe(0);
      }

      vi.setSystemTime(t0 + 25 * 3600_000);
      const before = model.calls;
      await syncAndRun(nearDeadline()); // day 1: same again
      expect(model.calls - before).toBe(2);
      for (const id of ["fake-a1", "fake-a2"]) {
        expect(rawPendingOf(id)).toMatchObject({ reason: "draft_failed" });
        expect(slopFailsOf(id)).toBe(0);
      }

      // Not capped: a later run with a full deadline does the retry (one attempt + one retry, per review).
      vi.setSystemTime(t0 + 50 * 3600_000);
      const before2 = model.calls;
      await syncAndRun();
      expect(model.calls - before2).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a non-slop failure (call_failed) does not reset slopFails", () => {
  it("slop, call_failed, slop: caps at 2 and sends a held alert", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      await syncAndRun(); // day 0: slop
      expect(rawPendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", slopFails: 1 });

      // Fake-a1 is drafted first (newest content): its one attempt call_fails, no retry is attempted.
      vi.setSystemTime(t0 + 25 * 3600_000);
      model.answers = ["__THROW__"];
      await syncAndRun(); // day 1: call_failed — carried forward unchanged, never reset to 0
      expect(rawPendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", slopFails: 1 });
      expect(mem.read(reviewPath("fake-a1"))?.heldAlertBasis).toBeUndefined();

      vi.setSystemTime(t0 + 50 * 3600_000);
      const alertsBefore = heldAlerts().length;
      await syncAndRun(); // day 2: slop again → 1 + 1 = 2, hits the cap, held for a person
      expect(rawPendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", slopFails: 2 });
      expect(mem.read(reviewPath("fake-a1"))?.heldAlertBasis).toBeDefined();
      expect(heldAlerts().length).toBeGreaterThan(alertsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

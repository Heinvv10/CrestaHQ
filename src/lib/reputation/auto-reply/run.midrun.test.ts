import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Anything switched off DURING a run stops the post (AUTO_REPLY_V1_PLAN.md
 * step 4 + 4b): the change lands inside the draft call, after the draft was
 * decided and before the final re-check. Plus the daily caps.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const hook = vi.hoisted(() => ({ during: null as null | (() => Promise<void> | void) }));
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  return {
    ...real,
    getReviewsAiFor: async (sa: string) => {
      const ai = await real.getReviewsAiFor(sa);
      return {
        ...ai,
        draftReply: async (input: Parameters<typeof ai.draftReply>[0]) => {
          const result = await ai.draftReply(input);
          await hook.during?.();
          return result;
        },
      };
    },
  };
});

import { SA, mem } from "@/test/gbp-sync-harness";
import {
  draftsMade, patchSettings, patchSub, pendingOf, posts, replyOf, resetAutoReply, syncAndRun,
} from "@/test/auto-reply-harness";
import { beginDraftCall } from "@/lib/reputation/draft";
import { sentimentUsagePath } from "@/lib/reputation/sentiment-calls";
import { autoReplyUsagePath, sastDay } from "./store";

const ORIGINAL = { ...process.env };
const utcDay = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  resetAutoReply();
  hook.during = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("changed mid-run → nothing posts", () => {
  const paused: Array<[string, () => void]> = [
    ["the Google gate off", () => patchSub({ googleEnabledByAgency: false })],
    ["the Reviews AI gate off", () => patchSub({ reviewsAiEnabledByAgency: false })],
    ["the auto-reply gate off", () => patchSub({ reviewsAutoReplyEnabledByAgency: false })],
    ["auto-reply switched off", () => patchSettings({ enabled: false })],
    ["the kill switch unset", () => void delete process.env.REVIEWS_AUTO_REPLY_ENABLED],
  ];
  it.each(paused)("%s → no post; the draft stays auto_queued (paused)", async (_l, change) => {
    hook.during = change;
    await syncAndRun();
    expect(posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "auto_queued" });
    expect(pendingOf("fake-a1")?.text).toEqual(expect.any(String));
  });

  it("the listing changed → no post", async () => {
    hook.during = () => {
      const listing = mem.read(`subAccounts/${SA}`)!.googleListing as Record<string, unknown>;
      patchSub({ googleListing: { ...listing, locationName: "locations/e2e-velo-gqeberha-north" } });
    };
    await syncAndRun();
    expect(posts()).toEqual([]);
  });

  it("its star switched to Approval → no post; the draft is kept and now waits for a person", async () => {
    hook.during = () => patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    await syncAndRun();
    expect(posts().length).toBe(1); // a2 (4★) still auto
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval", text: expect.any(String) });
    expect(replyOf("fake-a1")).toBeNull();
  });

  it("auto-reply switched off and on (backlog off, review now older) → held for approval", async () => {
    hook.during = () => patchSettings({ enabledAt: new Date("2026-09-01T00:00:00Z") });
    await syncAndRun();
    expect(posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval" });
  });

  it("a paused auto_queued draft posts when auto-reply resumes — the same bytes, no redraft", async () => {
    hook.during = () => patchSub({ reviewsAutoReplyEnabledByAgency: false });
    await syncAndRun();
    const text = pendingOf("fake-a1")!.text;
    hook.during = null;
    patchSub({ reviewsAutoReplyEnabledByAgency: true });
    const drafts = draftsMade();
    await syncAndRun();
    expect(replyOf("fake-a1")).toBe(text);
    expect(draftsMade()).toBe(drafts + 1); // a2 was never drafted in run 1 (the run stopped at a1)
  });
});

describe("caps", () => {
  it("auto-draft budget spent (40) → the next review is held without a draft (no_budget)", async () => {
    mem.seed(sentimentUsagePath(SA), { day: utcDay(), calls: 40, draftsDay: utcDay(), draftCalls: 40, autoDraftCalls: 40 });
    await syncAndRun();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "no_budget", text: null });
    expect([draftsMade(), posts().length]).toEqual([0, 0]);
  });

  it("39 used → one draft (the newest), then the 41st is held without a draft", async () => {
    mem.seed(sentimentUsagePath(SA), { day: utcDay(), calls: 39, draftsDay: utcDay(), draftCalls: 39, autoDraftCalls: 39 });
    await syncAndRun();
    expect(replyOf("fake-a1")).not.toBeNull();
    expect(pendingOf("fake-a2")).toMatchObject({ reason: "no_budget", text: null });
    expect(draftsMade()).toBe(1);
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ autoDraftCalls: 40, draftCalls: 40 });
  });

  it("yesterday's auto drafts do not count today", async () => {
    mem.seed(sentimentUsagePath(SA), { day: "2000-01-01", calls: 300, draftsDay: "2000-01-01", draftCalls: 100, autoDraftCalls: 40 });
    await syncAndRun();
    expect(posts()).toHaveLength(2);
  });

  it("20 posts today (SAST) → held without a draft (cap)", async () => {
    mem.seed(autoReplyUsagePath(SA), { day: sastDay(Date.now()), posts: 20 });
    await syncAndRun();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "cap", text: null });
    expect([draftsMade(), posts().length]).toEqual([0, 0]);
  });

  it("19 posts today → one more post, then the cap holds the next", async () => {
    mem.seed(autoReplyUsagePath(SA), { day: sastDay(Date.now()), posts: 19 });
    await syncAndRun();
    expect(posts()).toHaveLength(1);
    expect(pendingOf("fake-a2")).toMatchObject({ reason: "cap" });
    expect(mem.read(autoReplyUsagePath(SA))).toMatchObject({ posts: 20 });
  });

  it("the post-time transaction refuses the 21st even when decide saw room (a stale count)", async () => {
    hook.during = () => mem.seed(autoReplyUsagePath(SA), { day: sastDay(Date.now()), posts: 20 });
    await syncAndRun();
    expect(posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "auto_queued" });
  });

  it("a human draft on a new UTC day resets the auto share with the day, and never counts as auto", async () => {
    mem.seed(sentimentUsagePath(SA), { day: "2000-01-01", calls: 9, draftsDay: "2000-01-01", draftCalls: 90, autoDraftCalls: 40 });
    expect(await beginDraftCall(SA)).toBeNull();
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ draftsDay: utcDay(), draftCalls: 1, autoDraftCalls: 0 });
    expect(await beginDraftCall(SA)).toBeNull();
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ draftCalls: 2, autoDraftCalls: 0 });
  });

  it("the human's Draft with AI share is untouched: auto drafts stop at 40 of 100", async () => {
    mem.seed(sentimentUsagePath(SA), { day: utcDay(), calls: 60, draftsDay: utcDay(), draftCalls: 60, autoDraftCalls: 40 });
    await syncAndRun();
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ draftCalls: 60, autoDraftCalls: 40 });
  });
});

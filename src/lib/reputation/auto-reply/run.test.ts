import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-reply engine end to end on the seam (AUTO_REPLY_V1_PLAN.md
 * "Validation"): real sync, real fake GBP provider (putReply logged), real
 * Reviews AI fake, in-memory Firestore. `hook.during` runs INSIDE the draft
 * call — where a human reply, a Discard or a settings change races the engine.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const hook = vi.hoisted(() => ({ during: null as null | (() => Promise<void> | void), fail: false }));
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
          return hook.fail ? { text: null, failure: "call_failed" as const } : result;
        },
      };
    },
  };
});

import { SA, mem } from "@/test/gbp-sync-harness";
import { KEY, events, reviewPath, sha256 } from "@/test/gbp-reply-harness";
import {
  A1, A2, draftsMade, patchSettings, pendingOf, posts, putFixtureReview, replyOf, resetAutoReply, reviewNameOf, syncAndRun,
} from "@/test/auto-reply-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { loadReplyTarget, postReply } from "@/lib/gbp/reply";
import { autoReplyAfterSync } from "./run";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  resetAutoReply();
  hook.during = null;
  hook.fail = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the happy path", () => {
  it("auto-posts each eligible rating-only review exactly once; a second run posts nothing", async () => {
    const run = await syncAndRun();
    expect(run).toMatchObject({ posted: 2, drafted: 2, stop: null });
    expect(posts().map((c) => c.reviewName).sort()).toEqual([reviewNameOf("fake-a1"), reviewNameOf("fake-a2")].sort());
    expect(replyOf("fake-a1")).toMatch(/^Hi Fixture, thank you for your 5-star review/);

    expect(await syncAndRun()).toMatchObject({ posted: 0, drafted: 0 });
    expect(posts()).toHaveLength(2);
    expect(draftsMade()).toBe(2);
  });

  it("records the post: pendingReply cleared, autoReplied {at, key}, system actor, enabler as createdByUid", async () => {
    await syncAndRun();
    const doc = mem.read(reviewPath("fake-a1"))!;
    const text = replyOf("fake-a1")!;
    expect(doc.pendingReply).toBeNull();
    expect(doc.autoReplied).toMatchObject({ key: `auto:${A1}:${sha256(text)}` });
    const posted = events(SA, "reply_posted").find((e) => e.reviewDocId === A1);
    expect(posted).toMatchObject({ actorUid: "system:auto-reply", createdByUid: "uid_admin" });
    const audit = mem.list("auditEvents").filter((r) => r.action === "review.auto_replied");
    expect(audit.map((r) => (r.target as { id: string }).id).sort()).toEqual([A1, A2].sort());
    expect(audit[0]).toMatchObject({ actor: { type: "system", id: "auto-reply" }, subAccountId: SA, createdByUid: "uid_admin" });
    expect(JSON.stringify(audit)).not.toContain(text);
  });

  it("holds texted and approval-star reviews with a stored draft, posting none of them", async () => {
    patchSettings({ includeBacklog: true });
    await syncAndRun();
    expect(pendingOf("fake-r4")).toMatchObject({ reason: "texted", model: "fake" }); // 5★ texted
    expect(pendingOf("fake-r1")).toMatchObject({ reason: "texted" }); // 5★ padded text
    expect(pendingOf("fake-r6")).toMatchObject({ reason: "approval" }); // 2★
    expect(pendingOf("fake-r6")?.text).toMatch(/2-star review/);
    expect(posts()).toHaveLength(2); // a1 + a2 only
  });

  it("a reviewer's display name carrying a contact is dropped from the draft input, not refused", async () => {
    putFixtureReview("fake-a1", 5, null, 28, "Call 082 555 0101");
    await syncAndRun();
    expect(replyOf("fake-a1")).toMatch(/^Thank you for your 5-star review/);
    expect(replyOf("fake-a1")).not.toContain("Call");
  });
});

describe("the kill switch", () => {
  it("unset: the engine reads nothing, drafts nothing, posts nothing", async () => {
    delete process.env.REVIEWS_AUTO_REPLY_ENABLED;
    const doc = vi.spyOn(storeDb, "doc");
    const col = vi.spyOn(storeDb, "collection");
    expect(await autoReplyAfterSync(SA, new Date(0), Date.now() + 240_000)).toBeNull();
    expect(doc).not.toHaveBeenCalled();
    expect(col).not.toHaveBeenCalled();
    expect([posts(), draftsMade()]).toEqual([[], 0]);
  });

  it.each(["0", "true", ""])("any value but \"1\" (%j) is unset", async (v) => {
    process.env.REVIEWS_AUTO_REPLY_ENABLED = v;
    expect(await syncAndRun()).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe("races with a person", () => {
  it("a human reply landing during the draft call → no auto post", async () => {
    hook.during = async () => {
      hook.during = null;
      const target = (await loadReplyTarget(SA, A1))!;
      await postReply(SA, target, { comment: "Thanks from a human.", idempotencyKey: KEY }, "uid_admin");
    };
    await syncAndRun();
    expect(replyOf("fake-a1")).toBe("Thanks from a human.");
    expect(posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"))).toHaveLength(1);
    expect(pendingOf("fake-a1")).toBeNull();
  });

  it("two concurrent runs → one draft and one post per review", async () => {
    const { syncListing } = await import("@/lib/gbp/sync/run");
    const run = await syncListing(SA, { trigger: "manual" });
    const both = await Promise.all([
      autoReplyAfterSync(SA, run.startedAt, Date.now() + 240_000),
      autoReplyAfterSync(SA, run.startedAt, Date.now() + 240_000),
    ]);
    expect(both.map((r) => r?.stop).sort()).toEqual(["busy", null].sort());
    expect(posts()).toHaveLength(2);
    expect(draftsMade()).toBe(2);
  });
});

describe("failures", () => {
  it("a failed post, then a rerun, posts the stored bytes once — no second draft", async () => {
    const { setScenario } = await import("@/test/gbp-sync-harness");
    setScenario(SA, (s) => void (s.failNext = { op: "putReply", kind: "transient" }));
    const first = await syncAndRun();
    expect(first).toMatchObject({ posted: 0, stop: "post_stopped" });
    const queued = pendingOf("fake-a1")!;
    expect(queued).toMatchObject({ reason: "auto_queued" });
    expect(replyOf("fake-a1")).toBeNull();

    await syncAndRun();
    expect(replyOf("fake-a1")).toBe(queued.text);
    const a1Calls = posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"));
    expect(a1Calls).toHaveLength(2); // the failed one + the one that landed
    expect(draftsMade()).toBe(2); // a1 once, a2 once
  });

  it("a failed draft stores draft_failed with no text, and posts nothing", async () => {
    hook.fail = true;
    await syncAndRun();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "draft_failed", text: null, textHash: null });
    expect(posts()).toEqual([]);
  });

  it("the deadline passing between draft and post → no post, draft kept; the next run posts it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const deadline = Date.now() + 240_000;
    hook.during = () => {
      hook.during = null;
      vi.setSystemTime(deadline + 1);
    };
    const { sync } = await import("@/test/auto-reply-harness");
    const run = await sync();
    expect(await autoReplyAfterSync(SA, run.startedAt, deadline)).toMatchObject({ posted: 0, stop: "post_stopped" });
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "auto_queued" });
    expect(posts()).toEqual([]);
    const text = pendingOf("fake-a1")!.text;
    vi.useRealTimers();
    await syncAndRun();
    expect(replyOf("fake-a1")).toBe(text);
  });

  it("a deadline already passed → no draft at all", async () => {
    const { sync } = await import("@/test/auto-reply-harness");
    const run = await sync();
    expect(await autoReplyAfterSync(SA, run.startedAt, Date.now() - 1)).toMatchObject({ stop: "deadline", drafted: 0 });
    expect([posts(), draftsMade()]).toEqual([[], 0]);
  });

  it("the lease taken by another run during a draft → that draft is not posted", async () => {
    hook.during = () => {
      hook.during = null;
      mem.seed(`subAccounts/${SA}/private/autoReplyLease`, { runId: "someone-else", until: Date.now() + 300_000 });
    };
    await syncAndRun();
    expect(posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "auto_queued" });
  });

  it("the lease lost during a held draft → no further draft this run", async () => {
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    hook.during = () => {
      hook.during = null;
      mem.seed(`subAccounts/${SA}/private/autoReplyLease`, { runId: "someone-else", until: Date.now() + 300_000 });
    };
    expect(await syncAndRun()).toMatchObject({ stop: "lease_lost" });
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval" });
    expect(pendingOf("fake-a2")).toBeUndefined();
    expect(draftsMade()).toBe(1);
  });

  it("an engine error is contained: logged by kind, never thrown", async () => {
    vi.spyOn(storeDb, "collection").mockImplementation(() => {
      throw new TypeError("boom");
    });
    await expect(autoReplyAfterSync(SA, new Date(), Date.now() + 1000)).resolves.toBeNull();
  });
});

describe("stale cache", () => {
  it("a review the run did not see is skipped, even with backlog on", async () => {
    patchSettings({ includeBacklog: true });
    await syncAndRun();
    const stalePath = reviewPath("fake-stale");
    mem.seed(stalePath, {
      ...mem.read(reviewPath("fake-a1"))!, reviewName: reviewNameOf("fake-stale"), reply: null, pendingReply: null,
      autoReplied: null, lastSeenAt: new Date(Date.now() - 3600_000),
    });
    const before = [posts().length, draftsMade()];
    await syncAndRun();
    expect([posts().length, draftsMade()]).toEqual(before);
    expect(mem.read(stalePath)?.pendingReply).toBeNull();
  });
});

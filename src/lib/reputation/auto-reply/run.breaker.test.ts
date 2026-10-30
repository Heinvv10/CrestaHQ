import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The PR #287 breaker's repros, kept as regression tests: a deleted reply is
 * never replaced (sticky hadReply), no reviewer name in an auto post, a post
 * Google accepted but not recorded is finalized once, and a Discard or a
 * mode switch after the final re-check still stops the claim.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const hook = vi.hoisted(() => ({
  recordFailOnce: false,
  afterConfirm: null as null | (() => Promise<void> | void),
}));
vi.mock("@/lib/gbp/reply-attempts", async (orig) => {
  const real = await orig<typeof import("@/lib/gbp/reply-attempts")>();
  return {
    ...real,
    recordReplyChange: async (...a: Parameters<typeof real.recordReplyChange>) => {
      if (hook.recordFailOnce) { hook.recordFailOnce = false; throw new Error("firestore unavailable"); }
      return real.recordReplyChange(...a);
    },
  };
});
vi.mock("@/lib/reputation/auto-reply/confirm", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/auto-reply/confirm")>();
  return {
    ...real,
    confirmAutoPost: async (...a: Parameters<typeof real.confirmAutoPost>) => {
      const r = await real.confirmAutoPost(...a);
      if (r === "go" && hook.afterConfirm) { const f = hook.afterConfirm; hook.afterConfirm = null; await f(); }
      return r;
    },
  };
});

import { SA, mem, setScenario, LOC_A } from "@/test/gbp-sync-harness";
import { KEY } from "@/test/gbp-reply-harness";
import {
  A1, patchSettings, pendingOf, posts, putFixtureReview, replyOf, resetAutoReply, reviewDoc, reviewNameOf, sync, syncAndRun,
} from "@/test/auto-reply-harness";
import { deleteReplyFor, loadReplyTarget, postReply } from "@/lib/gbp/reply";
import { dismissAutoReply } from "./store";

const ORIGINAL = { ...process.env };
const a1Posts = () => posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"));

beforeEach(() => {
  resetAutoReply();
  hook.recordFailOnce = false;
  hook.afterConfirm = null;
  // Only fake-a1 is auto-eligible: 4★ set to approval (fake-a2 is 4★).
  patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "approval", 5: "auto" } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("BREAKER", () => {
  it("REPRO 1a: owner posts a reply, then DELETES it in LeadStack → engine must not auto-post", async () => {
    await sync();
    const target = (await loadReplyTarget(SA, A1))!;
    const res = await postReply(SA, target, { comment: "Thanks — the owner.", idempotencyKey: KEY }, "uid_admin");
    expect(res.status).toBe(200);
    const del = await deleteReplyFor(SA, (await loadReplyTarget(SA, A1))!, "uid_admin");
    expect(del.status).toBe(200);
    expect(replyOf("fake-a1")).toBeNull();

    await syncAndRun();
    expect(replyOf("fake-a1")).toBeNull(); // owner chose "no reply"
  });

  it("REPRO 1b: a reply (GHL/Google UI) later deleted at Google → engine must not auto-post", async () => {
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!;
      r.reply = { comment: "Thanks from GHL.", updateTime: "2026-08-28T10:00:00Z" };
    });
    await syncAndRun();
    expect(replyOf("fake-a1")).toBe("Thanks from GHL.");
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!;
      r.reply = null;
    });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  const clearAtGoogle = () => setScenario(SA, (s) => {
    s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!.reply = null;
  });
  const audits = () => mem.list("auditEvents").filter((r) => r.action === "review.auto_replied" && (r.target as { id: string }).id === A1).length;

  it("REPRO 2a: record failed + reply gone at Google before next sync → every run burns a cap slot and logs a false auto_replied audit, forever", async () => {
    hook.recordFailOnce = true;
    await syncAndRun();
    clearAtGoogle();
    for (let i = 0; i < 3; i++) await syncAndRun();
    const usage = mem.read(`subAccounts/${SA}/private/autoReplyUsage`) as { posts: number };
    expect({ googleCalls: a1Posts().length, audits: audits(), postsCounted: usage.posts, pending: pendingOf("fake-a1")?.reason ?? null })
      .toEqual({ googleCalls: 1, audits: 1, postsCounted: 1, pending: null });
  });

  it("REPRO 2b: record failed → autoReplied never stamped; owner deletes that auto reply at Google → a NEW AI reply is posted", async () => {
    hook.recordFailOnce = true;
    await syncAndRun();
    await sync(); // Google's reply imported
    // Fixed (PR #287 review): the unrecorded post is finalized — autoReplied + hadReply stamped.
    expect(reviewDoc("fake-a1").autoReplied).toMatchObject({ key: expect.stringMatching(/^auto:/) });
    clearAtGoogle(); // owner removes the unwanted auto reply
    // a real model is not deterministic; emulate a different draft
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, reviewsAiConfig: { replyGuidelines: "Sign off as the Velo team." } });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });

  it("REPRO 3: reviewer display name is echoed into a PUBLIC auto-post unvalidated", async () => {
    putFixtureReview("fake-a1", 5, null, 28, "Scammers!!!-avoid-this-business Smith");
    await syncAndRun();
    // Design ruling: the auto path passes NO reviewer name to the draft at all.
    expect(replyOf("fake-a1")).not.toContain("Scammers");
    expect(replyOf("fake-a1")).not.toContain("Smith");
  });

  it("REPRO 4: Discard landing after the final re-check but before the claim → still posted", async () => {
    hook.afterConfirm = async () => { await dismissAutoReply(SA, A1, "uid_admin", new Date()); };
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  it("a claim that finds the attempt already succeeded (race) is finalized — not audited, not reported posted", async () => {
    const { createHash } = await import("node:crypto");
    hook.afterConfirm = async () => {
      const p = pendingOf("fake-a1")!;
      const key = `auto:${A1}:${p.textHash}`;
      mem.seed(`subAccounts/${SA}/gbpReplyAttempts/${createHash("sha256").update(key).digest("hex").slice(0, 40)}`, {
        status: "succeeded", commentHash: createHash("sha256").update(p.text!).digest("hex"), reviewDocId: A1,
        replyUpdateTime: "2026-09-26T00:00:00Z", agencyId: "ag_1", subAccountId: SA, createdByUid: "uid_admin",
      });
    };
    const run = await syncAndRun();
    expect(run).toMatchObject({ posted: 0 });
    expect(a1Posts()).toHaveLength(0);
    expect(audits()).toBe(0);
    expect(reviewDoc("fake-a1")).toMatchObject({ pendingReply: null, hadReply: true });
  });

  it("REPRO 4b: star switched to Approval after the re-check but before the claim → still posted", async () => {
    hook.afterConfirm = () => patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "approval", 5: "approval" } });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });
});

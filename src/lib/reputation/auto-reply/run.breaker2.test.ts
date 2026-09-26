import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, OTHER_SA, mem, setScenario, LOC_A } from "@/test/gbp-sync-harness";
import { KEY, reviewPath } from "@/test/gbp-reply-harness";
import {
  A1, patchSettings, patchSub, pendingOf, posts, replyOf, resetAutoReply, reviewDoc, reviewNameOf, sync, syncAndRun,
} from "@/test/auto-reply-harness";
import { loadReplyTarget, postReply } from "@/lib/gbp/reply";
import { clearGbpCache } from "@/lib/gbp/sync/store";

const ORIGINAL = { ...process.env };
const a1Posts = () => posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"));
const setA1Reply = (reply: { comment: string; updateTime: string } | null) => setScenario(SA, (s) => {
  s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!.reply = reply;
});

beforeEach(() => {
  resetAutoReply();
  patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "approval", 5: "auto" } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("BREAKER round 2", () => {
  it("R2-1: hadReply lives only in the cache — a cache clear (Google gate toggle / listing A→B→A) forgets a deleted reply → auto-post", async () => {
    setA1Reply({ comment: "Thanks from GHL.", updateTime: "2026-08-28T10:00:00Z" });
    await syncAndRun();
    setA1Reply(null); // owner deletes the reply at Google
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0); // fixed so far
    await clearGbpCache(SA);
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  it("R2-1b: same after an AUTO reply: owner deletes the auto reply, cache clears → a second AI reply", async () => {
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
    setA1Reply(null);
    await clearGbpCache(SA);
    patchSub({ reviewsAiConfig: { replyGuidelines: "Sign off as the Velo team." } }); // a real model is not deterministic
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });

  it("R2-2: a reply cached WITHOUT hadReply (pre-deploy) then deleted before the next sync → hadReply never set → auto-post", async () => {
    setA1Reply({ comment: "Old reply.", updateTime: "2026-08-28T10:00:00Z" });
    await sync();
    const d = { ...reviewDoc("fake-a1") }; delete d.hadReply; mem.seed(reviewPath("fake-a1"), d); // as written before this PR
    setA1Reply(null);
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  it("R2-3: listing_shared — another sub-account selecting the same location AFTER enable pauses the post", async () => {
    await sync();
    mem.seed(`subAccounts/${OTHER_SA}`, { ...(mem.read(`subAccounts/${OTHER_SA}`) ?? {}), googleListing: { locationName: LOC_A } });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  it("R2-4: the human path is unchanged on a review holding a queued auto draft (post succeeds, auto never follows)", async () => {
    await sync();
    const { storePending } = await import("./store");
    const { reviewBasis } = await import("../sentiment-basis");
    await storePending(SA, A1, { text: "queued", basisHash: reviewBasis(reviewDoc("fake-a1"))!, reason: "auto_queued", model: "fake" }, new Date());
    const res = await postReply(SA, (await loadReplyTarget(SA, A1))!, { comment: "Human reply.", idempotencyKey: KEY }, "uid_admin");
    expect(res.status).toBe(200);
    await syncAndRun();
    expect({ reply: replyOf("fake-a1"), n: a1Posts().length, pending: pendingOf("fake-a1") ?? null }).toEqual({ reply: "Human reply.", n: 1, pending: null });
  });

  it("R2-5: a per-review Google refusal → post_failed; the next day's retry reuses the same key and posts once", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "putReply", kind: "not_found" }));
    const first = await syncAndRun();
    expect(pendingOf("fake-a1")?.reason).toBe("post_failed");
    expect(first?.stop ?? null).toBeNull();
    await syncAndRun(); // same day: waits
    expect(a1Posts()).toHaveLength(1);
    const p = reviewDoc("fake-a1").pendingReply as Record<string, unknown>;
    mem.seed(reviewPath("fake-a1"), { ...reviewDoc("fake-a1"), pendingReply: { ...p, at: new Date(Date.now() - 25 * 3600_000) } });
    await syncAndRun();
    await syncAndRun();
    expect(a1Posts()).toHaveLength(2);
    expect(replyOf("fake-a1")).toBe(p.text);
    expect(reviewDoc("fake-a1").autoReplied).toBeTruthy();
  });
});

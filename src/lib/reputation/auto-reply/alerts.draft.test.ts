import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A review a person must answer (Approval star) whose AI draft fails still
 * waits for that person — without a draft — so it is alerted once; its daily
 * retry failing again is not news. A failed draft of an Auto review retries
 * on its own and is not alerted. And the held alert goes out even when the
 * lease release throws.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const f = vi.hoisted(() => ({ failDraft: false, releaseThrows: false }));
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  return {
    ...real,
    getReviewsAiFor: async (sa: string) => {
      const ai = await real.getReviewsAiFor(sa);
      return {
        ...ai,
        draftReply: async (input: Parameters<typeof ai.draftReply>[0]) =>
          f.failDraft ? { text: null, failure: "refused" } : ai.draftReply(input),
      } as typeof ai;
    },
  };
});
vi.mock("./store", async (orig) => {
  const real = await orig<typeof import("./store")>();
  return {
    ...real,
    releaseAutoReplyLease: async (...a: Parameters<typeof real.releaseAutoReplyLease>) => {
      if (f.releaseThrows) throw new Error("injected: release failed");
      return real.releaseAutoReplyLease(...a);
    },
  };
});

import { SA, mem } from "@/test/gbp-sync-harness";
import { pendingOf, putFixtureReview, resetAutoReply, reviewDoc, syncAndRun } from "@/test/auto-reply-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { autoReplyAlertsCollection } from "./alerts";

const ORIGINAL = { ...process.env };
const held = () => mem.list(autoReplyAlertsCollection(SA)).filter((a) => a.kind === "held");

beforeEach(() => {
  resetAutoReply();
  f.failDraft = false;
  f.releaseThrows = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("an Approval review whose draft fails → one alert; its daily retry failing again → none", async () => {
  putFixtureReview("fake-h1", 3, "Slow install", 29);
  f.failDraft = true;
  await syncAndRun();
  expect(pendingOf("fake-h1")).toMatchObject({ reason: "draft_failed" });
  expect(held()).toMatchObject([{ count: 1 }]);
  // A day later: the retry runs (and fails) again.
  const doc = reviewDoc("fake-h1");
  const pending = doc.pendingReply as Record<string, unknown>;
  mem.seed(reviewPath("fake-h1"), { ...doc, pendingReply: { ...pending, at: new Date(Date.now() - 25 * 3600_000) } });
  await syncAndRun();
  expect((pendingOf("fake-h1") as unknown as { at: Date }).at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  expect(held()).toHaveLength(1);
});

it("an Auto review whose draft fails retries on its own → no alert", async () => {
  f.failDraft = true;
  await syncAndRun();
  expect(pendingOf("fake-a1")).toMatchObject({ reason: "draft_failed" });
  expect(held()).toEqual([]);
});

it("the lease release throws after a hold → the held alert still went out", async () => {
  putFixtureReview("fake-h1", 3, "Slow install", 29);
  f.releaseThrows = true;
  expect(await syncAndRun()).toBeNull();
  expect(pendingOf("fake-h1")).toMatchObject({ reason: "approval" });
  expect(held()).toMatchObject([{ count: 1 }]);
});

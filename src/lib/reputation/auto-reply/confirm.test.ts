import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * confirmAutoPost — the last re-check before an automatic post, one guard at
 * a time (AUTO_REPLY_V1_PLAN.md step 4 / 4b). Each case changes exactly one
 * thing from a state that answers "go".
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, mem } from "@/test/gbp-sync-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { A1, patchSettings, patchSub, resetAutoReply, sync } from "@/test/auto-reply-harness";
import { sentimentBasis } from "@/lib/reputation/sentiment-basis";
import { confirmAutoPost } from "./confirm";
import { autoReplyLeasePath, autoReplyUsagePath, sastDay, textHashOf } from "./store";

const ORIGINAL = { ...process.env };
const TEXT = "Thank you for the five stars.";
const HASH = textHashOf(TEXT);
const confirm = (runId = "run-1", textHash = HASH) => confirmAutoPost(SA, { runId, docId: A1, textHash }, Date.now());
const review = () => mem.read(reviewPath("fake-a1"))!;
const patchReview = (patch: Record<string, unknown>) => mem.seed(reviewPath("fake-a1"), { ...review(), ...patch });
const pending = (o: Record<string, unknown> = {}) => ({
  text: TEXT, textHash: HASH, basisHash: sentimentBasis(5, null), reason: "auto_queued", at: new Date(), model: "fake", ...o,
});

beforeEach(async () => {
  resetAutoReply();
  await sync();
  patchReview({ pendingReply: pending() });
  mem.seed(autoReplyLeasePath(SA), { runId: "run-1", until: Date.now() + 60_000 });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("go: counts the post (SAST day) and renews the lease", async () => {
  expect(await confirm()).toBe("go");
  expect(mem.read(autoReplyUsagePath(SA))).toEqual({ day: sastDay(Date.now()), posts: 1 });
  expect(mem.read(autoReplyLeasePath(SA))!.until as number).toBeGreaterThan(Date.now() + 200_000);
});

describe("stop the run", () => {
  it("lease held by another run → lease_lost", async () => {
    expect(await confirm("run-2")).toBe("lease_lost");
  });

  it.each<[string, () => void]>([
    ["kill switch unset", () => void delete process.env.REVIEWS_AUTO_REPLY_ENABLED],
    ["Google gate off", () => patchSub({ googleEnabledByAgency: false })],
    ["Reviews AI gate off", () => patchSub({ reviewsAiEnabledByAgency: false })],
    ["auto-reply gate off", () => patchSub({ reviewsAutoReplyEnabledByAgency: false })],
    ["auto-reply switched off", () => patchSettings({ enabled: false })],
    ["the listing changed", () => patchSub({ googleListing: { ...(mem.read(`subAccounts/${SA}`)!.googleListing as object), locationName: "locations/x" } })],
    ["enabled for another listing", () => patchSettings({ listingLocationName: "locations/x" })],
  ])("%s → paused, nothing counted, the draft stays queued", async (_l, change) => {
    change();
    expect(await confirm()).toBe("paused");
    expect(mem.read(autoReplyUsagePath(SA))).toBeUndefined();
    expect(review().pendingReply).toMatchObject({ reason: "auto_queued", text: TEXT });
  });

  it("20 posts today → cap; yesterday's 20 do not count", async () => {
    mem.seed(autoReplyUsagePath(SA), { day: sastDay(Date.now()), posts: 20 });
    expect(await confirm()).toBe("cap");
    mem.seed(autoReplyUsagePath(SA), { day: "2000-01-01", posts: 20 });
    expect(await confirm()).toBe("go");
  });
});

describe("skip this review (stale)", () => {
  it.each<[string, () => void]>([
    ["replied meanwhile", () => patchReview({ reply: { comment: "Human reply.", updateTime: "2026-09-01T00:00:00Z" } })],
    ["removed", () => patchReview({ state: "removed" })],
    ["another location's review", () => patchReview({ locationName: "locations/x" })],
    ["no draft any more", () => patchReview({ pendingReply: null })],
    ["discarded", () => patchReview({ pendingReply: pending({ reason: "dismissed" }) })],
    ["now held for approval", () => patchReview({ pendingReply: pending({ reason: "approval" }) })],
    ["different stored text", () => patchReview({ pendingReply: pending({ textHash: textHashOf("other") }) })],
    ["the review's stars changed", () => patchReview({ starRating: 4 })],
  ])("%s → stale, nothing counted", async (_l, change) => {
    change();
    expect(await confirm()).toBe("stale");
    expect(mem.read(autoReplyUsagePath(SA))).toBeUndefined();
  });

  it("a review deleted from the cache → stale", async () => {
    await mem.db.doc(reviewPath("fake-a1")).delete();
    expect(await confirm()).toBe("stale");
  });
});

describe("now waits for a person (text kept)", () => {
  it("its star switched to Approval → approval", async () => {
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    expect(await confirm()).toBe("approval");
    expect(review().pendingReply).toMatchObject({ reason: "approval", text: TEXT });
  });

  it("the review has written text (same basis) → texted", async () => {
    patchReview({ comment: "Fast install.", pendingReply: pending({ basisHash: sentimentBasis(5, "Fast install.") }) });
    expect(await confirm()).toBe("approval");
    expect(review().pendingReply).toMatchObject({ reason: "texted", text: TEXT });
  });

  it("auto-reply switched off and on after the review, backlog off → approval; backlog on → go", async () => {
    patchSettings({ enabledAt: new Date("2026-09-01T00:00:00Z") });
    expect(await confirm()).toBe("approval");
    patchReview({ pendingReply: pending() });
    patchSettings({ includeBacklog: true });
    expect(await confirm()).toBe("go");
  });
});

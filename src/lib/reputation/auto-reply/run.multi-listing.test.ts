import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_NORTH, OTHER_SA, SA, mem, reviewOn, seedExtraListing } from "@/test/gbp-sync-harness";
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { autoReplyAfterSync } from "@/lib/reputation/auto-reply/run";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { draftsMade, posts, resetAutoReply } from "@/test/auto-reply-harness";

/**
 * Auto-reply is main-listing-only in v1 (MULTI_LISTING_V1_PLAN.md PR 4):
 * an extra listing's rating-only reviews must never be drafted, queued or
 * posted by the engine, even though the same review-doc collection holds
 * both listings' reviews. Main still auto-posts (sanity: the engine ran).
 */

const ORIGINAL = { ...process.env };

async function syncAll() {
  const { runs } = await syncSubAccount(SA, { trigger: "manual", actorUid: "uid_admin" } as never);
  const startedAt = runs.map((r) => (r as unknown as { startedAt: Date }).startedAt).sort((a, b) => +a - +b)[0] ?? new Date();
  return autoReplyAfterSync(SA, startedAt, Date.now() + 240_000);
}

const northPending = () =>
  mem.list(reviewsCollection(SA)).filter((d) => d.locationName === LOC_NORTH);

/** Rating-only (blank comment) — otherwise eligible for auto-reply's "auto" verdict. */
const ratingOnly = (id: string, star: 4 | 5, day: number) => ({ ...reviewOn(LOC_NORTH, id, star, day), comment: null });

beforeEach(() => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Take OTHER_SA off LOC_NORTH so the extra is not "shared" (paused).
  const other = mem.read(`subAccounts/${OTHER_SA}`)!;
  mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: "locations/elsewhere" } });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("auto-reply never touches an extra listing", () => {
  it("zero drafts, zero pendingReply, zero posts on the extra; main still posts", async () => {
    // Rating-only, after enabledAt (2026-08-25) — otherwise eligible for
    // auto-reply but for the listing (this is the case the guard exists for).
    seedExtraListing(SA, LOC_NORTH, [ratingOnly("north-5", 5, 29), ratingOnly("north-4", 4, 30)]);
    const before = draftsMade();
    await syncAll();

    const northDocs = northPending();
    expect(northDocs.length).toBeGreaterThan(0);
    for (const d of northDocs) expect(d.pendingReply ?? null).toBeNull();

    const northPosts = posts().filter((p) => String(p.reviewName).includes(`${LOC_NORTH}/reviews/`));
    expect(northPosts).toEqual([]);

    // Main still auto-posts (sanity: the engine actually ran).
    expect(posts().length).toBeGreaterThan(0);
    expect(draftsMade()).toBeGreaterThan(before);
  });
});

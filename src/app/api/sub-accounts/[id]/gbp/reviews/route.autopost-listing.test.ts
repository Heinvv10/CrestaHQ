import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET …/gbp/reviews — "queued" vs "Auto-post paused" per listing
 * (MULTI_LISTING_V1_PLAN.md PR 6, `autoPostsFor(star, locationName)`): a
 * queued draft reads as queued only while auto-reply is on for THAT review's
 * listing and no other sub-account manages that listing. Real route and sync
 * on the in-memory store; `pendingReply` seeded directly.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, seedExtraListing } from "@/test/gbp-sync-harness";
import { patchSettings, ratingOnlyOn, resetAutoReply, switchExtraOn } from "@/test/auto-reply-harness";
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

async function state(reviewId: string) {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/reviews`, "uid_collab"), { params: Promise.resolve({ id: SA }) });
  const body = (await res.json()) as { reviews: Array<{ reviewId: string; approval: { state: string } | null }> };
  return body.reviews.find((r) => r.reviewId === reviewId)?.approval?.state;
}

function queue(reviewId: string) {
  const { id, ...d } = mem.list(reviewsCollection(SA)).find((x) => x.reviewId === reviewId)!;
  const basisHash = reviewBasis(d as Parameters<typeof reviewBasis>[0]);
  mem.seed(`${reviewsCollection(SA)}/${id}`, { ...d, pendingReply: { text: "Draft", textHash: "h", basisHash, reason: "auto_queued", at: new Date(), model: "m" } });
}

const setOther = (patch: Record<string, unknown>) => mem.seed(`subAccounts/${OTHER_SA}`, { ...mem.read(`subAccounts/${OTHER_SA}`)!, ...patch });

beforeEach(async () => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const other = mem.read(`subAccounts/${OTHER_SA}`)!;
  setOther({ googleListing: { ...(other.googleListing as object), locationName: "locations/elsewhere" } });
  seedExtraListing(SA, LOC_NORTH, [ratingOnlyOn(LOC_NORTH, "north-5", 5, 29)]);
  await syncSubAccount(SA, { trigger: "manual", actorUid: "uid_admin" });
  queue("north-5");
  queue("fake-a1");
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("autoPostsFor per listing", () => {
  it("main on, B off → main queued, B paused", async () => {
    expect([await state("fake-a1"), await state("north-5")]).toEqual(["queued", "paused"]);
  });

  it("B on, main off → B queued, main paused", async () => {
    patchSettings({ enabled: false });
    switchExtraOn(LOC_NORTH);
    expect([await state("fake-a1"), await state("north-5")]).toEqual(["paused", "queued"]);
  });

  it("both on, another sub-account manages B as an extra → B paused, main still queued", async () => {
    switchExtraOn(LOC_NORTH);
    setOther({ googleExtraListings: [{ locationName: LOC_NORTH }], googleLocationNames: ["locations/elsewhere", LOC_NORTH] });
    expect([await state("fake-a1"), await state("north-5")]).toEqual(["queued", "paused"]);
  });

  it("both on, another sub-account manages MAIN → main paused, B still queued", async () => {
    switchExtraOn(LOC_NORTH);
    setOther({ googleListing: { locationName: LOC_A } });
    expect([await state("fake-a1"), await state("north-5")]).toEqual(["paused", "queued"]);
  });
});

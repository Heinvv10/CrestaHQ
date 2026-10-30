import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fix round 3: removals are PER REVIEW. A complete, single-run pass counts a
 * miss for every active review it did not see; a review is tombstoned only
 * after two consecutive misses, and seeing it resets the count. The anomaly
 * brake sits on top: a pass that saw nothing, or that would remove more than
 * half of ten or more, confirms only on its third occurrence at least an hour
 * apart.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  LOC_A,
  NOW,
  SA,
  activeReviews,
  mem,
  recordingSleep,
  resetSync,
  reviews,
  setScenario,
  syncState,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { fakeScenarioPath, type FakeScenario } from "../provider/fake-scenario";
import { syncListing, type SyncOptions } from "./run";

const ORIGINAL = { ...process.env };
const HOUR = 3600_000;
let clock: ReturnType<typeof recordingSleep>;
let t = 0;
/** One pass, 6 hours after the previous one (or exactly `hoursAfterStart`). */
const sync = (hoursAfterStart?: number, over: Partial<SyncOptions> = {}) => {
  t = hoursAfterStart ?? t + 6;
  return syncListing(SA, { trigger: "scheduled", now: new Date(NOW.getTime() + t * HOUR), sleep: clock.sleep, ...over });
};
const byId = (id: string) => reviews().find((r) => r.reviewId === id);
const drop = (id: string) => setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.filter((r) => r.reviewId !== id)));

beforeEach(() => {
  resetSync();
  t = 0;
  clock = recordingSleep();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("a review removed at Google", () => {
  it("is tombstoned only after missing from TWO consecutive complete passes", async () => {
    await sync();
    drop("fake-r4");
    expect(await sync()).toMatchObject({ status: "success", reconciliation: "full", removed: 0 });
    expect(byId("fake-r4")).toMatchObject({ state: "active", missedPasses: 1 });
    expect(await sync()).toMatchObject({ reconciliation: "full", removed: 1 });
    expect(byId("fake-r4")).toMatchObject({ state: "removed" });
    expect(activeReviews()).toHaveLength(6);
  });

  it("seeing it again resets the count", async () => {
    await sync();
    setScenario(SA, () => {});
    const full = structuredClone(mem.read(fakeScenarioPath(SA))!);
    drop("fake-r4");
    await sync();
    expect(byId("fake-r4")?.missedPasses).toBe(1);
    mem.seed(fakeScenarioPath(SA), full);
    await sync();
    expect(byId("fake-r4")?.missedPasses).toBe(0);
    drop("fake-r4");
    expect(await sync()).toMatchObject({ removed: 0 });
    expect(byId("fake-r4")).toMatchObject({ state: "active", missedPasses: 1 });
  });
});

describe("the deletion-shift race (round-3 reproduction)", () => {
  it("a deletion after page 1 hides a live review for one pass — it is not tombstoned", async () => {
    await sync();
    // During the next pass Google deletes fake-r7 right after page 1 was
    // served: the offsets shift and fake-r4 is never fetched.
    const real = storeDb.doc.bind(storeDb);
    let reads = 0;
    const spy = vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      if (path === fakeScenarioPath(SA) && ++reads === 2) drop("fake-r7");
      return real(path);
    });
    const shifted = await sync();
    spy.mockRestore();
    expect(shifted).toMatchObject({ reconciliation: "full", removed: 0, reviewsSeen: 6 });
    expect(byId("fake-r4")).toMatchObject({ state: "active", missedPasses: 1 });
    expect(byId("fake-r7")).toMatchObject({ state: "active", missedPasses: 0 });

    // Next pass sees fake-r4 (reset); fake-r7 is really gone (first miss).
    expect(await sync()).toMatchObject({ removed: 0 });
    expect(byId("fake-r4")).toMatchObject({ state: "active", missedPasses: 0 });
    expect(byId("fake-r7")?.missedPasses).toBe(1);
    // …and its second miss removes it.
    expect(await sync()).toMatchObject({ removed: 1 });
    expect(byId("fake-r7")).toMatchObject({ state: "removed" });
    expect(byId("fake-r4")).toMatchObject({ state: "active" });
  });
});

describe("the anomaly brake", () => {
  it("one empty response never wipes a small listing, whatever the count says", async () => {
    await sync();
    setScenario(SA, (s: FakeScenario) => void ((s.reviews[LOC_A].reviews = []), (s.reviews[LOC_A].totalReviewCount = null)));
    expect(await sync()).toMatchObject({ reconciliation: "full", removed: 0 });
    expect(await sync()).toMatchObject({ status: "partial", reconciliation: "skipped_anomaly", removed: 0 });
    expect(activeReviews()).toHaveLength(7);
  });

  it("confirms only passes at least an hour apart — three presses of Sync now are not three confirmations", async () => {
    await sync();
    setScenario(SA, (s: FakeScenario) => void (s.reviews[LOC_A].reviews = []));
    await sync(12); // first miss for all seven
    expect(await sync(20)).toMatchObject({ reconciliation: "skipped_anomaly" });
    expect(syncState()?.anomalyStreak).toMatchObject({ removals: 7, count: 1 });
    expect(await sync(20.2)).toMatchObject({ reconciliation: "skipped_anomaly" });
    expect(await sync(20.4)).toMatchObject({ reconciliation: "skipped_anomaly" });
    expect(syncState()?.anomalyStreak).toMatchObject({ count: 1 });
    expect(await sync(21.1)).toMatchObject({ reconciliation: "skipped_anomaly" });
    expect(syncState()?.anomalyStreak).toMatchObject({ count: 2 });
    const third = await sync(22.2);
    expect(third).toMatchObject({ status: "success", reconciliation: "full_after_anomaly", removed: 7 });
    expect(activeReviews()).toHaveLength(0);
  });
});

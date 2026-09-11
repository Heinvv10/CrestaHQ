import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review fix round 1: the lease race with cache clears, resumed passes that
 * must not tombstone live reviews, pass-level rating/count, the anomaly
 * streak, and lease renewal. Same seam as run.test.ts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  LOC_A,
  LOC_NORTH,
  NOW,
  SA,
  activeReviews,
  mem,
  recordingSleep,
  resetSync,
  reviews,
  seedSub,
  setScenario,
  summaryOf,
  syncState,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { clearListing } from "../listing-events";
import { fakeScenarioPath } from "../provider/fake-scenario";
import { syncListing } from "./run";
import { LEASE_TTL_MS } from "./types";

const ORIGINAL = { ...process.env };
let clock: ReturnType<typeof recordingSleep>;
const sync = (over: Partial<Parameters<typeof syncListing>[1]> = {}) =>
  syncListing(SA, { trigger: "scheduled", now: NOW, sleep: clock.sleep, ...over });

/** Run `between` just before the run's FIRST transaction (the lease). */
function interleaveBeforeLease(between: () => Promise<void>) {
  const real = storeDb.runTransaction.bind(storeDb);
  let first = true;
  vi.spyOn(storeDb, "runTransaction").mockImplementation((async (fn: never) => {
    if (first) {
      first = false;
      await between();
    }
    return real(fn);
  }) as never);
}

beforeEach(() => {
  resetSync();
  clock = recordingSleep();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the lease re-checks the listing (H1)", () => {
  it("a listing cleared between the run's read and its lease: skipped listing_changed, nothing written", async () => {
    interleaveBeforeLease(() => clearListing(SA, "uid_admin", "admin_cleared"));
    const run = await sync();
    expect(run).toMatchObject({ status: "skipped", skipReason: "listing_changed", pagesFetched: 0 });
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toBeFalsy();
    expect(syncState()).toBeUndefined();
  });

  it("a DIFFERENT listing selected in between: nothing of the old one lands in the new cache", async () => {
    interleaveBeforeLease(async () => seedSub(SA, { listing: LOC_NORTH }));
    expect(await sync()).toMatchObject({ status: "skipped", skipReason: "listing_changed" });
    expect(reviews()).toHaveLength(0);
  });

  it.each([
    ["the gate switched off", { gateOn: false }],
    ["the connection flagged for reconnect", { reconnectRequired: true }],
    ["disconnected", { connected: false }],
  ])("%s in between: skipped listing_changed", async (_l, opts) => {
    interleaveBeforeLease(async () => seedSub(SA, opts));
    expect(await sync()).toMatchObject({ status: "skipped", skipReason: "listing_changed" });
    expect(reviews()).toHaveLength(0);
  });
});

describe("a resumed pass never tombstones a live review (H3)", () => {
  it("a CACHED review edited to page 1 between runs is not tombstoned; the pass removes nothing", async () => {
    await sync();
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: "3", kind: "permission_denied", times: 1 }));
    expect(await sync()).toMatchObject({ status: "partial", pagesFetched: 1 });
    setScenario(SA, (s) => {
      const list = s.reviews[LOC_A].reviews;
      const r2 = list.splice(list.findIndex((r) => r.reviewId === "fake-r2"), 1)[0];
      r2.comment = "Fixture review: signal is back.";
      r2.updateTime = "2026-09-10T09:00:00Z";
      list.unshift(r2);
    });
    const run = await sync({ now: new Date(NOW.getTime() + 6 * 3600_000) });
    expect(run).toMatchObject({ status: "success", resumedFromCursor: true, reconciliation: "deferred", removed: 0 });
    expect(activeReviews()).toHaveLength(7);
    expect(activeReviews().find((r) => r.reviewId === "fake-r2")).toBeDefined();
    expect(syncState()?.pass).toBeNull();
  });

  it("the breaker's case: new reviews arriving between runs cannot cover for a missed live one", async () => {
    // Fails at page 2 (not 3): with the fake's pages of 3, that is the offset
    // at which the new reviews land in the resumed pages and inflate the
    // distinct count to 8 ≥ Google's 7 — the case a count rule got wrong.
    await sync();
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: "3", kind: "permission_denied", times: 1 }));
    expect(await sync()).toMatchObject({ status: "partial", pagesFetched: 1 });
    setScenario(SA, (s) => {
      const list = s.reviews[LOC_A].reviews;
      const r1 = list.splice(list.findIndex((r) => r.reviewId === "fake-r1"), 1)[0];
      r1.comment = "Fixture review: edited to the top.";
      r1.updateTime = "2026-09-10T09:00:00Z";
      const fresh = [1, 2, 3, 4].map((n) => ({ ...list[0], name: list[0].name.replace("fake-r7", `fake-n${n}`), reviewId: `fake-n${n}` }));
      list.unshift(r1, ...fresh);
      s.reviews[LOC_A].totalReviewCount = 11;
    });
    // The pass's count stays the 7 it saw first; it sees 8 distinct reviews.
    const run = await sync({ now: new Date(NOW.getTime() + 6 * 3600_000) });
    expect(run).toMatchObject({ resumedFromCursor: true, reconciliation: "deferred", removed: 0 });
    expect(activeReviews().find((r) => r.reviewId === "fake-r1")).toBeDefined();
  });

  it("a single-run pass that sees NO reviews and no count (Google omits it at 0) removes them all", async () => {
    await sync();
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews = [];
      s.reviews[LOC_A].totalReviewCount = null;
    });
    expect(await sync()).toMatchObject({ status: "success", reconciliation: "full", removed: 7 });
    expect(activeReviews()).toHaveLength(0);
  });

  it("a single-run complete pass removes a review Google removed — with no count reported", async () => {
    await sync();
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.filter((r) => r.reviewId !== "fake-r4");
      s.reviews[LOC_A].totalReviewCount = null;
    });
    expect(await sync()).toMatchObject({ status: "success", reconciliation: "full", removed: 1 });
    expect(reviews().find((r) => r.reviewId === "fake-r4")).toMatchObject({ state: "removed" });
  });
});

describe("rating and count come from the pass, not the last page (M7)", () => {
  it("keeps the first non-null values across a resumed pass, and reconciles with them", async () => {
    setScenario(SA, (s) => void (s.laterPages = { averageRating: null, totalReviewCount: null }));
    await sync({ maxPages: 1 });
    expect(syncState()?.pass).toMatchObject({ averageRating: 3.6, totalReviewCount: 7 });
    const run = await sync({ now: new Date(NOW.getTime() + 6 * 3600_000) });
    // Resumed, so it removes nothing — but the rating/count survive the pass.
    expect(run).toMatchObject({ status: "success", resumedFromCursor: true, reconciliation: "deferred" });
    expect(summaryOf()).toMatchObject({ averageRating: 3.6, totalReviewCount: 7 });
  });
});

describe("the anomaly guard does not block a genuine mass removal forever (M5)", () => {
  it("applies the same removals on the third consecutive anomalous pass", async () => {
    setScenario(SA, (s) => {
      const base = s.reviews[LOC_A].reviews[0];
      for (let i = 8; i <= 12; i++) {
        s.reviews[LOC_A].reviews.push({ ...base, name: base.name.replace("fake-r7", `fake-r${i}`), reviewId: `fake-r${i}` });
      }
      s.reviews[LOC_A].totalReviewCount = 12;
    });
    await sync();
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.slice(0, 5);
      s.reviews[LOC_A].totalReviewCount = 5;
    });
    expect(await sync()).toMatchObject({ reconciliation: "skipped_anomaly", removed: 0 });
    expect(syncState()?.anomalyStreak).toEqual({ removals: 7, count: 1 });
    expect(await sync()).toMatchObject({ reconciliation: "skipped_anomaly", removed: 0 });
    const third = await sync();
    expect(third).toMatchObject({ status: "success", reconciliation: "full_after_anomaly", removed: 7 });
    expect(activeReviews()).toHaveLength(5);
    expect(syncState()?.anomalyStreak).toBeNull();
  });

  it("a different planned removal restarts the streak", async () => {
    setScenario(SA, (s) => {
      const base = s.reviews[LOC_A].reviews[0];
      for (let i = 8; i <= 12; i++) {
        s.reviews[LOC_A].reviews.push({ ...base, name: base.name.replace("fake-r7", `fake-r${i}`), reviewId: `fake-r${i}` });
      }
      s.reviews[LOC_A].totalReviewCount = 12;
    });
    await sync();
    const all = structuredClone(mem.read(fakeScenarioPath(SA)) as unknown as { reviews: Record<string, { reviews: unknown[] }> }).reviews[LOC_A].reviews;
    setScenario(SA, (s) => void ((s.reviews[LOC_A].reviews = all.slice(0, 5) as never), (s.reviews[LOC_A].totalReviewCount = 5)));
    await sync();
    await sync();
    setScenario(SA, (s) => void ((s.reviews[LOC_A].reviews = all.slice(0, 4) as never), (s.reviews[LOC_A].totalReviewCount = 4)));
    expect(await sync()).toMatchObject({ reconciliation: "skipped_anomaly", removed: 0 });
    expect(syncState()?.anomalyStreak).toEqual({ removals: 8, count: 1 });
  });
});

describe("lease renewal (L3)", () => {
  it("extends the lease on every page commit", async () => {
    let t = NOW.getTime();
    const renewals: number[] = [];
    const real = storeDb.doc.bind(storeDb);
    vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      if (path === fakeScenarioPath(SA)) {
        const lease = syncState()?.lease as { until: number } | undefined;
        if (lease) renewals.push(lease.until);
      }
      return real(path);
    });
    await sync({ clock: () => new Date((t += 60_000)) });
    expect(renewals[0]).toBe(NOW.getTime() + LEASE_TTL_MS);
    expect(renewals[1]).toBeGreaterThan(renewals[0]);
    expect(renewals[2]).toBeGreaterThan(renewals[1]);
  });
});

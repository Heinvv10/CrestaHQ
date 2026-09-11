import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * syncListing — the ONE core both Sync now and the cron use. Runs through the
 * real fence (getGbpProviderFor), the real token lifecycle + withGbpAccess,
 * PR 1's real fake provider and an in-memory Firestore. Nothing of ours is
 * mocked.
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
  runs,
  setScenario,
  summaryOf,
  syncState,
} from "@/test/gbp-sync-harness";
import { syncListing } from "./run";
import { reviewDocId } from "./store";
import type { FakeScenario } from "../provider/fake-scenario";

const ORIGINAL = { ...process.env };
const TRANSLATED =
  "(Translated by Google) Fixture review: the connection is okay.\n\n(Original)\nFixture-resensie: die verbinding is okay.";

let clock: ReturnType<typeof recordingSleep>;
const sync = (over: Parameters<typeof syncListing>[1] = { trigger: "manual" }) =>
  syncListing(SA, { now: NOW, sleep: clock.sleep, ...over });

beforeEach(() => {
  resetSync();
  clock = recordingSleep();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("first full sync", () => {
  it("stores every review once, byte-exact, anchored to the tenant", async () => {
    const run = await sync({ trigger: "manual", actorUid: "uid_admin" });
    expect(run).toMatchObject({
      status: "success", trigger: "manual", actorUid: "uid_admin", pagesFetched: 3, reviewsSeen: 7,
      created: 7, updated: 0, unchanged: 0, removed: 0, reconciliation: "full", resumedFromCursor: false,
      errorKind: null, skipReason: null, agencyId: "ag_1", subAccountId: SA, createdByUid: "uid_admin",
      locationName: LOC_A,
    });
    expect(reviews()).toHaveLength(7);
    const r5 = mem.read(`subAccounts/${SA}/gbpReviews/${reviewDocId(`accounts/e2e-fixture-group/${LOC_A}/reviews/fake-r5`)}`);
    expect(r5).toMatchObject({ agencyId: "ag_1", subAccountId: SA, createdByUid: "uid_admin", comment: TRANSLATED, state: "active", starRating: 3 });
    const r1 = activeReviews().find((r) => r.reviewId === "fake-r1");
    expect(r1?.comment).toBe("  Fixture review with leading and trailing spaces.  ");
    const r7 = activeReviews().find((r) => r.reviewId === "fake-r7");
    expect(r7?.reply).toEqual({ comment: "Thank you from the fixture team.", updateTime: "2026-08-27T12:00:00Z" });
  });

  it("writes the summary from the provider and records one append-only run", async () => {
    await sync();
    expect(summaryOf()).toMatchObject({
      locationName: LOC_A, averageRating: 3.6, totalReviewCount: 7, lastRunStatus: "success",
      lastErrorKind: null, health: "ok",
    });
    expect((summaryOf()?.lastSuccessfulSyncAt as Date).getTime()).toBe(NOW.getTime());
    expect(runs()).toHaveLength(1);
    expect(JSON.stringify(runs()[0])).not.toMatch(/Fixture review|fake-access|fake-refresh/);
    expect(syncState()).toMatchObject({ lease: null, pass: null });
  });
});

describe("idempotency and reconciliation", () => {
  it("a repeated sync creates and updates nothing", async () => {
    await sync();
    const second = await sync({ trigger: "scheduled" });
    expect(second).toMatchObject({ status: "success", created: 0, updated: 0, unchanged: 7, removed: 0 });
    expect(reviews()).toHaveLength(7);
  });

  it("a changed review updates that one doc, in place", async () => {
    await sync();
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-r6")!;
      r.comment = "Fixture review: technician arrived late, but fixed it.";
      r.starRating = 4;
      r.updateTime = "2026-09-01T09:00:00Z";
    });
    const run = await sync();
    expect(run).toMatchObject({ created: 0, updated: 1, unchanged: 6 });
    expect(reviews()).toHaveLength(7);
    const r6 = activeReviews().find((r) => r.reviewId === "fake-r6");
    expect(r6).toMatchObject({ comment: "Fixture review: technician arrived late, but fixed it.", starRating: 4 });
  });

  it("a changed owner reply reconciles without a duplicate", async () => {
    await sync();
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-r2")!.reply = {
        comment: "Sorry — fixture team is on it.",
        updateTime: "2026-09-02T08:00:00Z",
      };
    });
    const run = await sync();
    expect(run).toMatchObject({ created: 0, updated: 1 });
    expect(activeReviews().find((r) => r.reviewId === "fake-r2")?.reply).toEqual({
      comment: "Sorry — fixture team is on it.",
      updateTime: "2026-09-02T08:00:00Z",
    });
    expect(reviews()).toHaveLength(7);
  });

  it("a removed review is tombstoned after a FULL pass, its content stripped", async () => {
    await sync();
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.filter((x) => x.reviewId !== "fake-r4");
      s.reviews[LOC_A].totalReviewCount = 6;
    });
    const run = await sync();
    expect(run).toMatchObject({ status: "success", removed: 1, reconciliation: "full" });
    const gone = reviews().find((r) => r.reviewId === "fake-r4");
    expect(gone).toMatchObject({ state: "removed", comment: null, reviewer: null, reply: null });
    expect((gone?.removedAt as Date).getTime()).toBe(NOW.getTime());
    expect(activeReviews()).toHaveLength(6);
  });

  it("a review that comes back after removal is restored, not duplicated", async () => {
    setScenario(SA, () => {});
    await sync();
    const saved = structuredClone(mem.read(`subAccounts/${SA}/private/gbpFakeScenario`));
    setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.filter((x) => x.reviewId !== "fake-r4")));
    await sync();
    mem.seed(`subAccounts/${SA}/private/gbpFakeScenario`, saved ?? {});
    const run = await sync();
    expect(run).toMatchObject({ created: 0, updated: 1, removed: 0 });
    expect(activeReviews()).toHaveLength(7);
    expect(activeReviews().find((r) => r.reviewId === "fake-r4")?.comment).toBe("Fixture review: fast and friendly.");
  });

  it("does not remove anything when the pass is not full (maxPages hit)", async () => {
    await sync();
    setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.slice(1)));
    const run = await sync({ trigger: "scheduled", maxPages: 1 });
    expect(run).toMatchObject({ status: "partial", reconciliation: "deferred", removed: 0, pagesFetched: 1 });
    expect(activeReviews()).toHaveLength(7);
    expect(syncState()?.pass).toMatchObject({ pageToken: "3", pagesDone: 1 });
  });
});

describe("anomaly guard", () => {
  it("refuses to remove when the pass saw nothing but Google reports reviews", async () => {
    await sync();
    setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = []));
    const run = await sync();
    expect(run).toMatchObject({ status: "partial", reconciliation: "skipped_anomaly", removed: 0 });
    expect(activeReviews()).toHaveLength(7);
    expect(syncState()?.pass).toBeNull();
  });

  it("refuses to remove more than half of ten or more active reviews", async () => {
    setScenario(SA, (s) => {
      const base = s.reviews[LOC_A].reviews[0];
      for (let i = 8; i <= 12; i++) {
        s.reviews[LOC_A].reviews.push({ ...base, name: `${base.name.replace("fake-r7", `fake-r${i}`)}`, reviewId: `fake-r${i}` });
      }
      s.reviews[LOC_A].totalReviewCount = 12;
    });
    await sync();
    expect(activeReviews()).toHaveLength(12);
    const all = structuredClone((mem.read(`subAccounts/${SA}/private/gbpFakeScenario`) as unknown as FakeScenario).reviews[LOC_A].reviews);
    setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = all.slice(0, 5)));
    const guarded = await sync();
    expect(guarded).toMatchObject({ status: "partial", reconciliation: "skipped_anomaly", removed: 0 });
    expect(activeReviews()).toHaveLength(12);
    setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = all.slice(0, 6)));
    expect(await sync()).toMatchObject({ status: "success", reconciliation: "full", removed: 6 });
  });
});

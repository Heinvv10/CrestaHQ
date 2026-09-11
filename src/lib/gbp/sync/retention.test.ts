import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google's content policy: cached content is "stored temporarily for no more
 * than 30 calendar days" (developers.google.com/my-business/content/policies).
 * Both rules, with an injected clock, through the real sync core.
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
  summaryOf,
} from "@/test/gbp-sync-harness";
import { syncListing } from "./run";

const ORIGINAL = { ...process.env };
const DAY = 24 * 3600_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
let clock: ReturnType<typeof recordingSleep>;
const sync = (now: Date) => syncListing(SA, { trigger: "scheduled", now, sleep: clock.sleep });

function seedOrphan(id: string, lastSeenDaysAgo: number, now: Date) {
  mem.seed(`subAccounts/${SA}/gbpReviews/${id}`, {
    agencyId: "ag_1", subAccountId: SA, createdByUid: "uid_admin", locationName: LOC_A,
    reviewName: `accounts/e2e-fixture-group/${LOC_A}/reviews/${id}`, reviewId: id,
    reviewer: { displayName: "Old Fixture", profilePhotoUrl: null, isAnonymous: false },
    starRating: 4, comment: "Old fixture text", createTime: at(-60), updateTime: at(-60), reply: null,
    state: "active", firstSeenAt: at(-60), lastSeenAt: new Date(now.getTime() - lastSeenDaysAgo * DAY),
    removedAt: null, passId: "old-pass", contentHash: "x",
  });
}

beforeEach(() => {
  resetSync();
  clock = recordingSleep();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("a review not re-seen for 30 days", () => {
  it("is DELETED (not tombstoned), even when the run itself fails", async () => {
    seedOrphan("old-31", 31, NOW);
    seedOrphan("old-29", 29, NOW);
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "permission_denied" }));
    const run = await sync(NOW);
    expect(run).toMatchObject({ status: "failed", purged: 1 });
    expect(reviews().map((r) => r.id)).toEqual(["old-29"]);
  });

  it("is deleted on a successful run too, before reconciliation could tombstone it", async () => {
    seedOrphan("old-31", 31, NOW);
    const run = await sync(NOW);
    expect(run).toMatchObject({ status: "success", purged: 1, removed: 0 });
    expect(reviews().find((r) => r.id === "old-31")).toBeUndefined();
    expect(activeReviews()).toHaveLength(7);
  });
});

describe("no successful sync for 30 days", () => {
  async function syncedThenAged() {
    await sync(NOW);
    // Reviews re-seen recently (partial runs), but no SUCCESS for 31 days.
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: at(-31) },
    });
  }

  it("a failed run deletes ALL cached review content and reports retention_expired", async () => {
    await syncedThenAged();
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "transient" }));
    const run = await sync(at(0.5));
    expect(run).toMatchObject({ status: "failed", purged: 7 });
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toMatchObject({
      health: "error", lastErrorKind: "retention_expired", averageRating: null, totalReviewCount: null,
    });
  });

  it("a reconnect-required run deletes it too", async () => {
    await syncedThenAged();
    setScenario(SA, (s) => void (s.revoked = true));
    const run = await sync(at(0.5));
    expect(run).toMatchObject({ status: "reconnect_required", purged: 7 });
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toMatchObject({ health: "error", lastErrorKind: "retention_expired" });
  });

  it("a skipped reconnect-required run deletes it too", async () => {
    await syncedThenAged();
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleConnectionMeta: { ...(sub.googleConnectionMeta as object), reconnectRequired: true },
    });
    const run = await sync(at(0.5));
    expect(run).toMatchObject({ status: "skipped", skipReason: "reconnect_required", purged: 7 });
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toMatchObject({ health: "error", lastErrorKind: "retention_expired" });
  });

  it("drops a half-done pass with the content, so the next pass starts at page 1", async () => {
    await syncedThenAged();
    await syncListing(SA, { trigger: "scheduled", now: at(0.25), sleep: clock.sleep, maxPages: 1 });
    expect(mem.read(`subAccounts/${SA}/private/gbpSyncState`)?.pass).toMatchObject({ pageToken: "3" });
    const run = await sync(at(0.5));
    expect(run).toMatchObject({ status: "success", resumedFromCursor: false, created: 7, pagesFetched: 3 });
  });

  it("a successful run starts over with fresh content and is healthy again", async () => {
    await syncedThenAged();
    const run = await sync(at(0.5));
    expect(run).toMatchObject({ status: "success", purged: 7, created: 7, reconciliation: "full" });
    expect(activeReviews()).toHaveLength(7);
    expect(summaryOf()).toMatchObject({ health: "ok", lastErrorKind: null, averageRating: 3.6 });
  });
});

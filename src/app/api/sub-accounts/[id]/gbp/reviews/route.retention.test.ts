import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/gbp/reviews — what the read itself enforces:
 * the 30-day content rule at read time (whether or not a sync ran), schedule
 * honesty, the last run's reconciliation, and the 500-record cap.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { GET } from "./route";

const ORIGINAL = { ...process.env };
const DAY = 24 * 3600_000;

async function read() {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/reviews`, "uid_admin"), {
    params: Promise.resolve({ id: SA }),
  });
  return (await res.json()) as {
    summary: Record<string, unknown> | null;
    reviews: Array<Record<string, unknown>>;
    scheduled: boolean;
    truncated: boolean;
  };
}

function age(docId: string, days: number) {
  const path = `subAccounts/${SA}/gbpReviews/${docId}`;
  mem.seed(path, { ...mem.read(path)!, lastSeenAt: new Date(Date.now() - days * DAY) });
}

beforeEach(async () => {
  resetSync();
  delete process.env.GBP_SYNC_SCHEDULE_ENABLED;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("read-time retention (never serve content older than 30 days)", () => {
  it("hides a review not re-seen for 30 days, even though no sync has purged it", async () => {
    const ids = mem.list(`subAccounts/${SA}/gbpReviews`).map((d) => d.id);
    age(ids[0], 31);
    age(ids[1], 29);
    const body = await read();
    expect(body.reviews).toHaveLength(6);
  });

  it("nulls rating and count once the last success is older than 30 days", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(Date.now() - 31 * DAY) },
    });
    expect((await read()).summary).toMatchObject({ averageRating: null, totalReviewCount: null, health: "error" });
  });
});

describe("a first run that has started but not finished (stamped marker)", () => {
  it("reads as never synced — no rating, no success, nothing claimed", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      gbpSummary: {
        locationName: LOC_A, averageRating: null, totalReviewCount: null, lastSuccessfulSyncAt: null,
        lastRunAt: new Date(), lastRunStatus: "running", lastErrorKind: null, health: "never_synced",
      },
    });
    expect((await read()).summary).toMatchObject({
      health: "never_synced", lastRunStatus: "running", averageRating: null, lastSuccessfulSyncAt: null,
    });
  });
});

describe("schedule honesty", () => {
  it("says scheduled only when the deployment enables the schedule", async () => {
    expect((await read()).scheduled).toBe(false);
    process.env.GBP_SYNC_SCHEDULE_ENABLED = "1";
    expect((await read()).scheduled).toBe(true);
    process.env.GBP_SYNC_SCHEDULE_ENABLED = "true";
    expect((await read()).scheduled).toBe(false);
  });
});

describe("the last run's reconciliation reaches the page", () => {
  it("is in the summary", async () => {
    expect((await read()).summary?.lastReconciliation).toBe("full");
  });
});

describe("the 500-record cap", () => {
  it("exactly 500 records is NOT truncated", async () => {
    for (let i = 0; i < 493; i++) {
      mem.seed(`subAccounts/${SA}/gbpReviews/extra${i}`, {
        subAccountId: SA, locationName: LOC_A, reviewId: `extra${i}`, state: "active", starRating: 4,
        createTime: new Date(Date.UTC(2026, 9, 1) + i), lastSeenAt: new Date(), comment: null,
      });
    }
    const body = await read();
    expect(body.reviews).toHaveLength(500);
    expect(body.truncated).toBe(false);
  });

  it("says so when the cap was hit", async () => {
    expect((await read()).truncated).toBe(false);
    for (let i = 0; i < 500; i++) {
      mem.seed(`subAccounts/${SA}/gbpReviews/extra${i}`, {
        subAccountId: SA, locationName: LOC_A, reviewId: `extra${i}`, state: "active", starRating: 4,
        createTime: new Date(Date.UTC(2026, 9, 1) + i), lastSeenAt: new Date(), comment: null,
      });
    }
    const body = await read();
    expect(body.truncated).toBe(true);
    expect(body.reviews).toHaveLength(500);
  });
});

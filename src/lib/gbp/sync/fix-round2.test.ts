import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review fix round 2: the cache clear holds the lease while it deletes, the
 * run reads its previous summary inside the lease, the retention clock with
 * no success ever recorded, and "first non-null wins" for the pass's rating.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  NOW,
  SA,
  mem,
  recordingSleep,
  resetSync,
  reviews,
  runs,
  setScenario,
  summaryOf,
  syncState,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { syncListing, type SyncOptions } from "./run";
import { clearGbpCache } from "./store";

const ORIGINAL = { ...process.env };
const DAY = 24 * 3600_000;
let clock: ReturnType<typeof recordingSleep>;
const sync = (over: Partial<SyncOptions> = {}) =>
  syncListing(SA, { trigger: "scheduled", now: NOW, sleep: clock.sleep, ...over });

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

describe("clearGbpCache holds the lease while it deletes (M4)", () => {
  it("a run starting mid-clear is refused, and the clear leaves nothing behind", async () => {
    await syncListing(SA, { trigger: "scheduled", sleep: clock.sleep });
    let midClear: Awaited<ReturnType<typeof syncListing>> | null = null;
    const realBatch = storeDb.batch;
    vi.spyOn(storeDb, "batch").mockImplementationOnce(() => {
      const b = realBatch();
      const commit = b.commit;
      b.commit = async () => {
        // Between the clear's first write and its deletes.
        midClear = await syncListing(SA, { trigger: "scheduled", sleep: clock.sleep });
        return commit();
      };
      return b;
    });
    await clearGbpCache(SA);
    expect(midClear).toMatchObject({ status: "skipped", skipReason: "already_running" });
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toBeNull();
    expect(syncState()).toBeUndefined();
  });

  it("a run already in flight stops writing once the clear begins", async () => {
    const real = storeDb.doc.bind(storeDb);
    let scenarioReads = 0;
    vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      // While the run fetches page 2, the cache is cleared under it.
      if (path.endsWith("/private/gbpFakeScenario") && ++scenarioReads === 2) void clearGbpCache(SA);
      return real(path);
    });
    const run = await sync();
    expect(run).toMatchObject({ status: "failed", errorKind: "lease_lost" });
    await new Promise((r) => setTimeout(r, 20));
    expect(reviews()).toHaveLength(0);
  });
});

describe("only a cache that can no longer sync drops its summary when empty", () => {
  it("a SYNCING run over an empty cache (a 0-review listing) that dies keeps its summary", async () => {
    setScenario(SA, (s) => void ((s.reviews["locations/e2e-velo-gqeberha"].reviews = []), (s.reviews["locations/e2e-velo-gqeberha"].totalReviewCount = 0)));
    await sync();
    expect(summaryOf()).toMatchObject({ lastRunStatus: "success", totalReviewCount: 0 });
    const real = storeDb.doc.bind(storeDb);
    vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      // The run loses its lease while fetching its first page.
      if (path.endsWith("/private/gbpFakeScenario")) void real(`subAccounts/${SA}/private/gbpSyncState`).delete();
      return real(path);
    });
    expect(await sync({ now: new Date(NOW.getTime() + 3600_000) })).toMatchObject({ errorKind: "lease_lost" });
    expect(summaryOf()).toMatchObject({ lastRunStatus: "success", totalReviewCount: 0 });
  });
});

describe("a clear that dies midway (L)", () => {
  it("has already reset the pass cursor and the anomaly streak with its first write", async () => {
    await sync({ maxPages: 1 });
    const state = mem.read(`subAccounts/${SA}/private/gbpSyncState`)!;
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, { ...state, anomalyStreak: { removals: 3, count: 1, lastAt: 1 } });
    vi.spyOn(storeDb, "batch").mockImplementationOnce(() => {
      throw new Error("14 UNAVAILABLE");
    });
    await expect(clearGbpCache(SA)).rejects.toThrow("UNAVAILABLE");
    expect(syncState()).toMatchObject({ lease: { runId: "clearing" }, pass: null, anomalyStreak: null });
  });
});

describe("an internal failure records from the summary read inside the lease (M14)", () => {
  it("never re-stores a rating the lease-read summary says is past 30 days", async () => {
    await sync();
    const real = storeDb.runTransaction.bind(storeDb);
    let first = true;
    vi.spyOn(storeDb, "runTransaction").mockImplementation((async (fn: never) => {
      if (first) {
        first = false;
        const sub = mem.read(`subAccounts/${SA}`)!;
        mem.seed(`subAccounts/${SA}`, {
          ...sub,
          gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(NOW.getTime() - 31 * DAY) },
        });
        mem.seed(`subAccounts/${SA}/private/gbpFakeScenario`, { accounts: "not an array" });
      }
      return real(fn);
    }) as never);
    const run = await sync({ now: new Date(NOW.getTime() + 3600_000) });
    expect(run).toMatchObject({ status: "failed", errorKind: "internal" });
    expect(summaryOf()).toMatchObject({ lastRunStatus: "failed", averageRating: null, totalReviewCount: null });
  });
});

describe("the previous summary is read inside the lease (L5)", () => {
  it("a summary aged past 30 days between the run's read and its lease is honoured", async () => {
    await sync();
    const real = storeDb.runTransaction.bind(storeDb);
    let first = true;
    vi.spyOn(storeDb, "runTransaction").mockImplementation((async (fn: never) => {
      if (first) {
        first = false;
        const sub = mem.read(`subAccounts/${SA}`)!;
        mem.seed(`subAccounts/${SA}`, {
          ...sub,
          gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(NOW.getTime() - 31 * DAY) },
        });
      }
      return real(fn);
    }) as never);
    const run = await sync({ now: new Date(NOW.getTime() + 3600_000) });
    expect(run).toMatchObject({ purged: 7 });
  });
});

describe("retention with no success ever recorded (survivor)", () => {
  it("a full purge 31 days ago with no success since is itself the clock", async () => {
    await sync({ maxPages: 1 });
    expect(summaryOf()?.lastSuccessfulSyncAt).toBeNull();
    const state = mem.read(`subAccounts/${SA}/private/gbpSyncState`)!;
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, { ...state, retentionPurgedAt: NOW.getTime() - 31 * DAY });
    const run = await sync({ now: new Date(NOW.getTime() + 3600_000) });
    expect(run).toMatchObject({ purged: 3, resumedFromCursor: false, status: "success" });
  });
});

describe("the pass's rating: the FIRST non-null wins (survivor)", () => {
  it("a later page reporting different values does not change them", async () => {
    setScenario(SA, (s) => void (s.laterPages = { averageRating: 4.9, totalReviewCount: 99 }));
    await sync();
    expect(summaryOf()).toMatchObject({ averageRating: 3.6, totalReviewCount: 7 });
    expect(runs()).toHaveLength(1);
  });
});

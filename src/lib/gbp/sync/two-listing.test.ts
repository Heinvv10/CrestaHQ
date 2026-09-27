import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MULTI_LISTING_V1_PLAN.md H2 — sync per listing. Two listings on one
 * sub-account (main LOC_A with 7 reviews, extra LOC_NORTH with 3) share the
 * review collection; each has its own lease, pass, anomaly streak, retention
 * clock and summary, so a pass of one can never count a miss for, tombstone
 * or purge the other's reviews. Real core, real fake provider, in-memory
 * Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  LOC_A,
  LOC_NORTH,
  NOW,
  SA,
  mem,
  recordingSleep,
  removeExtraListings,
  resetSync,
  reviews,
  runs,
  seedExtraListing,
  setScenario,
  summaryOf,
  syncState,
} from "@/test/gbp-sync-harness";
import { locId } from "../listings";
import { syncListing } from "./run";
import { retainSubAccount, syncSubAccount } from "./sub-account";
import { runGbpSyncSweep } from "./sweep";
import { syncStatePath } from "./types";

const ORIGINAL = { ...process.env };
const HOUR = 3600_000;
const DAY = 24 * HOUR;
let clock: ReturnType<typeof recordingSleep>;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const opts = (hours: number) => ({ trigger: "scheduled" as const, now: at(hours), sleep: clock.sleep });
const on = (loc: string) => reviews().filter((r) => r.locationName === loc);
const northSummary = () => (mem.read(`subAccounts/${SA}`)?.gbpSummaries as Record<string, Record<string, unknown>> | undefined)?.[locId(LOC_NORTH)];
const northState = () => mem.read(syncStatePath(SA, LOC_NORTH));

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

describe("single listing: unchanged", () => {
  it("one run, the legacy state doc and gbpSummary only — no per-listing fields appear", async () => {
    const { runs: done, synced } = await syncSubAccount(SA, opts(0));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ locationName: LOC_A, status: "success", created: 7 });
    expect(synced).toEqual({ subAccountId: SA, created: 7, updated: 0, startedAt: done[0].startedAt });
    expect(summaryOf()).toMatchObject({ locationName: LOC_A, lastRunStatus: "success", totalReviewCount: 7 });
    expect(mem.read(`subAccounts/${SA}`)).not.toHaveProperty("gbpSummaries");
    expect(syncState()).toMatchObject({ lease: null, pass: null });
    expect(mem.all().filter((d) => /gbpSyncState_/.test(d.path))).toEqual([]);
    expect(runs()).toHaveLength(1);
  });
});

describe("two listings", () => {
  beforeEach(() => seedExtraListing(SA));

  it("syncs both, each into its own state doc and summary, as ONE aggregate", async () => {
    const { runs: done, synced } = await syncSubAccount(SA, opts(0));
    expect(done.map((r) => [r.locationName, r.status, r.created])).toEqual([
      [LOC_A, "success", 7],
      [LOC_NORTH, "success", 3],
    ]);
    expect(synced).toMatchObject({ subAccountId: SA, created: 10, updated: 0 });
    expect(on(LOC_A)).toHaveLength(7);
    expect(on(LOC_NORTH)).toHaveLength(3);
    expect(summaryOf()).toMatchObject({ locationName: LOC_A, totalReviewCount: 7 });
    expect(northSummary()).toMatchObject({ locationName: LOC_NORTH, totalReviewCount: 3, lastRunStatus: "success" });
    expect(northState()).toMatchObject({ lease: null, pass: null });
    expect(runs()).toHaveLength(2);
  });

  it("repeated complete passes of the main listing never count a miss for the extra's reviews", async () => {
    await syncSubAccount(SA, opts(0));
    for (const h of [6, 12, 18]) expect(await syncListing(SA, opts(h))).toMatchObject({ status: "success", removed: 0 });
    expect(on(LOC_NORTH)).toHaveLength(3);
    for (const r of on(LOC_NORTH)) expect(r).toMatchObject({ state: "active", missedPasses: 0 });
  });

  it("and the extra's passes never count one for the main's", async () => {
    await syncSubAccount(SA, opts(0));
    for (const h of [6, 12, 18]) expect(await syncListing(SA, opts(h), LOC_NORTH)).toMatchObject({ status: "success", removed: 0 });
    for (const r of on(LOC_A)) expect(r).toMatchObject({ state: "active", missedPasses: 0 });
  });

  it("a review gone from the extra at Google is tombstoned on the extra's passes only", async () => {
    await syncSubAccount(SA, opts(0));
    setScenario(SA, (s) => void (s.reviews[LOC_NORTH].reviews = s.reviews[LOC_NORTH].reviews.slice(1)));
    await syncSubAccount(SA, opts(6));
    await syncSubAccount(SA, opts(12));
    expect(on(LOC_NORTH).filter((r) => r.state === "removed").map((r) => r.reviewId)).toEqual(["north-3"]);
    expect(on(LOC_A).every((r) => r.state === "active")).toBe(true);
  });

  it("the main listing's 30-day purge leaves the extra's reviews and summary alone", async () => {
    await syncSubAccount(SA, opts(0));
    // The main listing fails for 31 days; the extra keeps succeeding.
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "permission_denied" }));
    const main = await syncListing(SA, opts(31 * 24));
    expect(main).toMatchObject({ status: "failed" });
    expect(main.purged).toBe(7);
    expect(on(LOC_A)).toHaveLength(0);
    expect(on(LOC_NORTH)).toHaveLength(3);
    expect(northSummary()).toMatchObject({ totalReviewCount: 3, lastRunStatus: "success" });
    expect(northState()?.retentionPurgedAt ?? null).toBeNull();
  });

  it("one listing's lease never refuses the other's run", async () => {
    mem.seed(syncStatePath(SA, LOC_NORTH), { lease: { runId: "other", until: at(1).getTime() }, pass: null });
    expect(await syncListing(SA, opts(0))).toMatchObject({ status: "success" });
    expect(await syncListing(SA, opts(0), LOC_NORTH)).toMatchObject({ status: "skipped", skipReason: "already_running" });
  });

  it("an extra removed from the doc is not synced as one (listing_changed), and leaves the loop", async () => {
    await syncSubAccount(SA, opts(0));
    removeExtraListings(SA);
    expect(await syncListing(SA, opts(6), LOC_NORTH)).toMatchObject({ status: "skipped", skipReason: "listing_changed" });
    expect((await syncSubAccount(SA, opts(12))).runs).toHaveLength(1);
  });

  it("retention visits every listing's cache", async () => {
    await syncSubAccount(SA, opts(0));
    const recs = await retainSubAccount(SA, { now: new Date(Date.now() + 31 * DAY) });
    expect(recs.map((r) => [r.locationName, r.purged])).toEqual([[LOC_A, 7], [LOC_NORTH, 3]]);
  });

  it("the sweep hands auto-reply + sentiment ONE aggregate per sub-account", async () => {
    const handed: unknown[] = [];
    const result = await runGbpSyncSweep({ sleep: clock.sleep, onRun: (r) => handed.push(r) });
    expect(handed.filter((r) => (r as { subAccountId: string }).subAccountId === SA)).toEqual([
      expect.objectContaining({ subAccountId: SA, created: 10 }),
    ]);
    // Two tenants (SA, OTHER_SA); SA's two listings are each tallied.
    expect(result).toMatchObject({ processed: 2, byStatus: { success: 3 } });
  });
});

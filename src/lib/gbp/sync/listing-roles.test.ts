import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MULTI_LISTING_V1_PLAN.md PR 2 — a listing's ROLE (main or extra) changing
 * under a run, and a removed listing's leftovers. Regressions from the PR #311
 * breaker (R1–R4) and blind review (#2, #3). Real core, real fake provider,
 * in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { storeDb } from "@/test/gbp-sync-store";
import {
  LOC_A, LOC_NORTH, NOW, SA, mem, recordingSleep, removeExtraListings, resetSync, reviewOn, reviews, runs, seedExtraListing,
  setScenario, summaryOf,
} from "@/test/gbp-sync-harness";
import { fakeScenarioPath } from "../provider/fake-scenario";
import { locId } from "../listings";
import { clearGbpCache } from "./clear";
import { recordFailedRun } from "./record";
import { syncListing } from "./run";
import { syncSubAccount } from "./sub-account";
import { runGbpRetentionSweep } from "./sweep";
import { syncStatePath } from "./types";
import type { SubAccountDoc } from "@/types";

const HOUR = 3600_000;
const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
const sleep = recordingSleep().sleep;
const opts = (h: number) => ({ trigger: "scheduled" as const, now: at(h), sleep });
const on = (loc: string) => reviews().filter((r) => r.locationName === loc);
const sub = () => mem.read(`subAccounts/${SA}`)!;
const northSummary = () => (sub().gbpSummaries as Record<string, Record<string, unknown>> | undefined)?.[locId(LOC_NORTH)];
const northReviews = (n: number) => Array.from({ length: n }, (_, i) => reviewOn(LOC_NORTH, `north-${i}`, 5, 10 + i));

/** Run `between` (awaited) when the provider reads the scenario for the `nth` time. */
function onScenarioRead(nth: number, between: () => Promise<void>) {
  const real = storeDb.doc.bind(storeDb);
  let reads = 0;
  vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
    const ref = real(path);
    if (path === fakeScenarioPath(SA) && ++reads === nth) {
      const get = ref.get.bind(ref);
      return { ...ref, get: async () => { await between(); return get(); } } as typeof ref;
    }
    return ref;
  });
}

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("R1 — an extra promoted to main mid-pass", () => {
  it("the extra-role run loses its lease at the next page, so the new main's clear leaves it empty", async () => {
    seedExtraListing(SA, LOC_NORTH, northReviews(7)); // 3 pages
    onScenarioRead(2, async () => {
      // The listing PUT picking LOC_NORTH as main (extras untouched), then its clear under the MAIN lease.
      const north = (sub().googleExtraListings as Array<Record<string, unknown>>)[0];
      mem.seed(`subAccounts/${SA}`, { ...sub(), googleListing: { ...north } });
      await clearGbpCache(SA);
    });
    const run = await syncListing(SA, opts(0), LOC_NORTH);
    expect({ status: run.status, errorKind: run.errorKind, docsBehindClear: on(LOC_NORTH).length }).toEqual({
      status: "failed", errorKind: "lease_lost", docsBehindClear: 0,
    });
  });
});

describe("a removed extra's leftovers are the main listing's to purge, never to reconcile", () => {
  it("R2: the removal's clear racing a MAIN run leaves no field-less zombie docs", async () => {
    seedExtraListing(SA);
    await syncSubAccount(SA, opts(0));
    expect(on(LOC_NORTH)).toHaveLength(3);
    removeExtraListings(SA);
    onScenarioRead(1, () => clearGbpCache(SA, LOC_NORTH));
    await syncListing(SA, opts(1));
    expect(reviews().filter((r) => r.locationName === undefined)).toEqual([]);
    expect(on(LOC_NORTH)).toEqual([]);
  });

  it("R3: orphans do not trip the main anomaly brake — main's genuine removal goes through", async () => {
    seedExtraListing(SA, LOC_NORTH, northReviews(8));
    await syncSubAccount(SA, opts(0));
    removeExtraListings(SA); // its clear never ran
    setScenario(SA, (s) => void (s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.slice(1)));
    await syncListing(SA, opts(1));
    const r = await syncListing(SA, opts(2));
    expect({ status: r.status, reconciliation: r.reconciliation, removed: r.removed }).toEqual({
      status: "success", reconciliation: "full", removed: 1,
    });
    // Never miss-counted or tombstoned…
    expect(on(LOC_NORTH).map((d) => [d.state, d.missedPasses])).toEqual(Array(8).fill(["active", 0]));
    // …but still purged by the main listing's 30-day rule, while the main keeps syncing.
    await syncListing(SA, opts(15 * 24));
    expect(await syncListing(SA, opts(31 * 24))).toMatchObject({ status: "success" });
    expect(on(LOC_NORTH)).toEqual([]);
    expect(on(LOC_A).filter((d) => d.state === "active")).toHaveLength(6);
  });
});

describe("R4 — retention keeps finding an extra's cache after the main one empties", () => {
  it("the extra's reviews and summary are purged by day 40; the main summary goes only after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    seedExtraListing(SA);
    vi.setSystemTime(NOW);
    await syncSubAccount(SA, opts(0));
    // Day 5: the main listing fails, the extra syncs fine.
    setScenario(SA, (s) => void (s.failNext = { op: "listReviews", kind: "permission_denied" }));
    const d5 = await syncSubAccount(SA, opts(5 * 24));
    expect(d5.runs.map((r) => r.status)).toEqual(["failed", "success"]);
    // Gate off and its clear failed: the retention sweep is the backstop.
    mem.seed(`subAccounts/${SA}`, { ...sub(), googleEnabledByAgency: false });
    vi.setSystemTime(at(31 * 24));
    await runGbpRetentionSweep();
    expect(on(LOC_A)).toHaveLength(0);
    expect(summaryOf()).not.toBeNull(); // still findable: the extra holds a cache
    vi.setSystemTime(at(40 * 24)); // 35 days after the extra last synced
    await runGbpRetentionSweep();
    expect({ north: on(LOC_NORTH).length, northSummary: northSummary() ?? null }).toEqual({ north: 0, northSummary: null });
    vi.setSystemTime(at(41 * 24));
    await runGbpRetentionSweep();
    expect(summaryOf()).toBeNull();
  });
});

describe("the lease's role guard (review #2)", () => {
  it("an extra removed between syncListing's read and the lease is refused listing_changed", async () => {
    seedExtraListing(SA);
    const real = storeDb.runTransaction.bind(storeDb);
    let n = 0;
    vi.spyOn(storeDb, "runTransaction").mockImplementation(((fn: never) => {
      if (++n === 1) removeExtraListings(SA); // the first transaction is acquireLease
      return real(fn);
    }) as typeof storeDb.runTransaction);
    const run = await syncListing(SA, opts(0), LOC_NORTH);
    expect(run).toMatchObject({ status: "skipped", skipReason: "listing_changed" });
    expect(on(LOC_NORTH)).toEqual([]);
    expect(mem.read(syncStatePath(SA, LOC_NORTH))).toBeUndefined();
  });

  it("recordFailedRun for an extra writes its own summary, never the main's", async () => {
    seedExtraListing(SA);
    await syncSubAccount(SA, opts(0));
    const main = structuredClone(summaryOf());
    const rec = await recordFailedRun(SA, sub() as unknown as SubAccountDoc, "scheduled", null, at(1), "sync", LOC_NORTH);
    expect(rec).toMatchObject({ locationName: LOC_NORTH, status: "failed", errorKind: "internal" });
    expect(runs().filter((r) => r.runId === rec.runId)).toHaveLength(1);
    expect(northSummary()).toMatchObject({ locationName: LOC_NORTH, lastRunStatus: "failed" });
    expect(summaryOf()).toEqual(main);
  });

  it("recordFailedRun for an extra no longer connected records the run but no summary", async () => {
    seedExtraListing(SA);
    const before = structuredClone(sub());
    removeExtraListings(SA);
    const rec = await recordFailedRun(SA, before as unknown as SubAccountDoc, "scheduled", null, at(1), "sync", LOC_NORTH);
    expect(runs().map((r) => r.runId)).toEqual([rec.runId]);
    expect(northSummary()).toBeUndefined();
  });
});

describe("quota stop (review #3)", () => {
  it("the main listing rate_limited: the extra is not attempted", async () => {
    seedExtraListing(SA);
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "rate_limited" }));
    const { runs: done } = await syncSubAccount(SA, opts(0));
    expect(done.map((r) => [r.locationName, r.errorKind])).toEqual([[LOC_A, "rate_limited"]]);
    expect(runs().map((r) => r.locationName)).toEqual([LOC_A]);
    expect(mem.read(syncStatePath(SA, LOC_NORTH))).toBeUndefined();
  });
});

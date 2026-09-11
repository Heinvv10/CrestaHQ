import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduled sweep: which sub-accounts it picks, in what order, how many,
 * and that one tenant's failure never stops the others. Real syncListing,
 * real fence, real fake provider, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  FOREIGN_AGENCY,
  FOREIGN_SA,
  OTHER_SA,
  SA,
  activeReviews,
  mem,
  resetSync,
  reviews,
  runs,
  seedSub,
  setScenario,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { fakeScenarioPath } from "../provider/fake-scenario";
import { runGbpSyncSweep, SWEEP_CAP } from "./sweep";

const ORIGINAL = { ...process.env };
const noSleep = async () => {};

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("selection", () => {
  it("syncs every gated, connected sub-account with a listing, as scheduled runs", async () => {
    seedSub("sa_gate_off", { gateOn: false });
    seedSub("sa_no_listing", { listing: null });
    seedSub("sa_disconnected", { connected: false });
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result).toMatchObject({ processed: 2, byStatus: { success: 2 }, retained: 0 });
    expect(runs(SA)).toEqual([expect.objectContaining({ trigger: "scheduled", actorUid: null, status: "success" })]);
    expect(activeReviews(OTHER_SA)).toHaveLength(7);
    for (const sa of ["sa_gate_off", "sa_no_listing", "sa_disconnected"]) expect(runs(sa)).toHaveLength(0);
  });

  it("in fake mode never touches a sub-account of another agency — not even its scenario", async () => {
    seedSub(FOREIGN_SA, { agencyId: FOREIGN_AGENCY });
    const reads = vi.spyOn(storeDb, "doc");
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result.processed).toBe(2);
    expect(runs(FOREIGN_SA)).toHaveLength(0);
    expect(reviews(FOREIGN_SA)).toHaveLength(0);
    expect(mem.read(`subAccounts/${FOREIGN_SA}/private/gbpSyncState`)).toBeUndefined();
    expect(reads.mock.calls.map(([p]) => p)).not.toContain(fakeScenarioPath(FOREIGN_SA));
  });

  it("goes never-synced first, then oldest lastRunAt first, and stops at the cap", async () => {
    mem.clear();
    resetSync();
    for (let i = 0; i < SWEEP_CAP + 2; i++) {
      seedSub(`sa_n${String(i).padStart(2, "0")}`);
      const sub = mem.read(`subAccounts/sa_n${String(i).padStart(2, "0")}`)!;
      mem.seed(`subAccounts/sa_n${String(i).padStart(2, "0")}`, {
        ...sub,
        gbpSummary: { lastRunAt: new Date(Date.UTC(2026, 8, 1, i)) },
      });
    }
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result.processed).toBe(SWEEP_CAP);
    // SA and OTHER_SA have never run: they go first. The two most recently
    // run (n25, n26) wait for the next sweep.
    expect(runs(SA)).toHaveLength(1);
    expect(runs(OTHER_SA)).toHaveLength(1);
    expect(runs("sa_n25")).toHaveLength(0);
    expect(runs("sa_n26")).toHaveLength(0);
    expect(runs("sa_n22")).toHaveLength(1);
  });
});

describe("isolation", () => {
  it("one tenant failing — or throwing — never stops the others", async () => {
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "permission_denied" }));
    seedSub("sa_broken");
    mem.seed(fakeScenarioPath("sa_broken"), { accounts: "not an array" });
    seedSub("sa_ok");
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result).toMatchObject({ processed: 4, byStatus: { failed: 2, success: 2 } });
    expect(runs(SA)[0]).toMatchObject({ status: "failed", errorKind: "permission_denied" });
    expect(runs("sa_broken")[0]).toMatchObject({ status: "failed", errorKind: "internal" });
    expect(activeReviews("sa_ok")).toHaveLength(7);
    expect(activeReviews(OTHER_SA)).toHaveLength(7);
  });

  it("a tenant whose sync throws before recording anything still gets a failed run", async () => {
    // A Firestore outage on the first transaction (one tenant's lease).
    vi.spyOn(storeDb, "runTransaction").mockRejectedValueOnce(new Error("14 UNAVAILABLE"));
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result).toMatchObject({ processed: 2, byStatus: { failed: 1, success: 1 } });
    const failed = [...runs(SA), ...runs(OTHER_SA)].filter((r) => r.status === "failed");
    expect(failed).toEqual([expect.objectContaining({ trigger: "scheduled", errorKind: "internal", agencyId: "ag_1" })]);
    // …and it moves to the back of the queue instead of starving the sweep.
    const failedSa = String(failed[0].subAccountId);
    const summary = mem.read(`subAccounts/${failedSa}`)?.gbpSummary as Record<string, unknown>;
    expect(summary).toMatchObject({ lastRunStatus: "failed", lastErrorKind: "internal" });
    expect(summary.lastRunAt).toBeInstanceOf(Date);
  });
});

describe("the sweep's failure record respects retention", () => {
  it("never re-stores a rating whose last success is older than 30 days", async () => {
    await runGbpSyncSweep({ sleep: noSleep });
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(Date.now() - 31 * 24 * 3600_000) },
    });
    seedSub(OTHER_SA, { gateOn: false }); // only SA is swept
    vi.spyOn(storeDb, "runTransaction").mockRejectedValueOnce(new Error("14 UNAVAILABLE"));
    await runGbpSyncSweep({ sleep: noSleep });
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toMatchObject({
      lastRunStatus: "failed", averageRating: null, totalReviewCount: null,
    });
  });
});

describe("rate limits (quota is project-wide)", () => {
  it("stops starting new tenants once one is rate limited", async () => {
    for (const sa of ["sa_c", "sa_d", "sa_e", "sa_f"]) seedSub(sa);
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "rate_limited" }));
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result.stoppedOnRateLimit).toBe(true);
    expect(runs(SA)[0]).toMatchObject({ errorKind: "rate_limited" });
    // Three workers were already running; nobody picks up the rest.
    expect(result.processed).toBe(3);
    expect(runs("sa_e")).toHaveLength(0);
    expect(runs("sa_f")).toHaveLength(0);
  });
});

describe("retention-only pass for caches that can no longer sync", () => {
  const DAY = 24 * 3600_000;
  async function cachedThenGateOff(lastSuccessDaysAgo: number, reviewAgeDays = 0) {
    await runGbpSyncSweep({ sleep: noSleep });
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleEnabledByAgency: false,
      gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(Date.now() - lastSuccessDaysAgo * DAY) },
    });
    const first = reviews(SA)[0];
    mem.seed(`subAccounts/${SA}/gbpReviews/${first.id}`, { ...first, lastSeenAt: new Date(Date.now() - reviewAgeDays * DAY) });
  }

  it("a gate-off tenant past 30 days without success: everything purged, summary dropped, no Google call", async () => {
    await cachedThenGateOff(31);
    setScenario(SA, (s) => void (s.failNext = { op: "listReviews", kind: "transient" }));
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result.retained).toBe(1);
    expect(reviews(SA)).toHaveLength(0);
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toBeNull();
    expect(mem.read(fakeScenarioPath(SA))?.failNext).toBeDefined();
    expect(runs(SA).find((r) => r.skipReason === "gate_off")).toMatchObject({ status: "skipped", purged: 7 });
    // Out of the query now: the next sweep leaves it alone.
    expect((await runGbpSyncSweep({ sleep: noSleep })).retained).toBe(0);
  });

  it("a never-succeeded gate-off tenant with an empty cache leaves the retention list", async () => {
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "permission_denied" }));
    await runGbpSyncSweep({ sleep: noSleep });
    expect(reviews(SA)).toHaveLength(0);
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toMatchObject({ lastSuccessfulSyncAt: null });
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleEnabledByAgency: false });
    expect((await runGbpSyncSweep({ sleep: noSleep })).retained).toBe(1);
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toBeNull();
    expect((await runGbpSyncSweep({ sleep: noSleep })).retained).toBe(0);
  });

  it("within 30 days: only the review not re-seen for 30 days goes", async () => {
    await cachedThenGateOff(2, 31);
    await runGbpSyncSweep({ sleep: noSleep });
    expect(reviews(SA)).toHaveLength(6);
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toBeTruthy();
  });

  it("in Google mode finds such caches with a single-field inequality (no index) — and never calls Google", async () => {
    await cachedThenGateOff(31);
    seedSub(OTHER_SA, { gateOn: false }); // nothing sync-eligible: no real Google call is possible
    delete process.env.GBP_PROVIDER;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await runGbpSyncSweep({ sleep: noSleep });
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ processed: 0, retained: 1 });
    expect(reviews(SA)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

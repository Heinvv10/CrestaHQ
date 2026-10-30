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
  SCOPE,
  seedSub,
  setScenario,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { fakeScenarioPath } from "../provider/fake-scenario";
import { runGbpRetentionSweep, runGbpSyncSweep, SWEEP_CAP } from "./sweep";

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

describe("in Google mode", () => {
  // CI and dev share this Firestore: an E2E spec leaves its fixture tenant gated,
  // connected and listed. The production sweep must not carry the fake's token to
  // Google — it answers `revoked` and the fixture is flagged reconnect-required mid-spec.
  const secretPath = (sa: string) => `subAccounts/${sa}/private/googleConnection`;
  const realCredentials = (sa: string) =>
    mem.seed(secretPath(sa), {
      refreshToken: "1//real-refresh-token", accessToken: "ya29.real", accessTokenExpiresAt: Date.now() + 3_600_000, scopes: [SCOPE],
    });
  const googleMode = () => {
    delete process.env.GBP_PROVIDER;
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  };
  /** Make the guard's first read of this tenant's secret reject (later reads, the sync's own, succeed). */
  const failFirstSecretRead = (sa: string) => {
    const real = storeDb.doc.bind(storeDb);
    let failed = false;
    vi.spyOn(storeDb, "doc").mockImplementation(((path: string) => {
      const ref = real(path);
      if (path !== secretPath(sa) || failed) return ref;
      failed = true;
      return { ...ref, get: () => Promise.reject(Object.assign(new Error("14 UNAVAILABLE"), { name: "GrpcError" })) };
    }) as never);
  };

  it("never takes a tenant holding the fake's credentials to Google, and touches nothing of it", async () => {
    realCredentials(OTHER_SA);
    const before = mem.read(`subAccounts/${SA}`);
    const fetchSpy = googleMode();
    const result = await runGbpSyncSweep({ sleep: noSleep });
    vi.unstubAllGlobals();
    expect(result.processed).toBe(1);
    expect(runs(OTHER_SA)).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalled();
    expect(runs(SA)).toHaveLength(0);
    expect(mem.read(`subAccounts/${SA}`)).toEqual(before);
  });

  it("a credential read that fails syncs that tenant anyway — one bad read never stops the sweep", async () => {
    realCredentials(OTHER_SA);
    failFirstSecretRead(OTHER_SA);
    googleMode();
    const result = await runGbpSyncSweep({ sleep: noSleep });
    vi.unstubAllGlobals();
    expect(result.processed).toBe(1);
    expect(runs(OTHER_SA)).toHaveLength(1);
    expect(runs(SA)).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(`[cron/gbp-sync] credential check failed sa=${OTHER_SA}: GrpcError`);
  });

  it("a tenant with no secret doc is not mistaken for a fake one", async () => {
    await storeDb.doc(secretPath(OTHER_SA)).delete();
    googleMode();
    const result = await runGbpSyncSweep({ sleep: noSleep });
    vi.unstubAllGlobals();
    expect(result.processed).toBe(1);
    expect(runs(OTHER_SA)).toHaveLength(1);
    expect(runs(SA)).toHaveLength(0);
  });

  it("reads the secret of only as many tenants as the cap needs", async () => {
    mem.clear();
    resetSync();
    for (let i = 0; i < SWEEP_CAP + 5; i++) {
      const sa = `sa_n${String(i).padStart(2, "0")}`;
      seedSub(sa);
      realCredentials(sa);
      mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, gbpSummary: { lastRunAt: new Date(Date.UTC(2026, 8, 1, i)) } });
    }
    realCredentials(SA);
    realCredentials(OTHER_SA);
    const reads: string[] = [];
    const real = storeDb.doc.bind(storeDb);
    vi.spyOn(storeDb, "doc").mockImplementation(((path: string) => (reads.push(path), real(path))) as never);
    googleMode();
    const result = await runGbpSyncSweep({ sleep: noSleep });
    vi.unstubAllGlobals();
    expect(result.processed).toBe(SWEEP_CAP);
    // Never-run SA and OTHER_SA go first; the five most recently run wait their turn, unread.
    for (let i = SWEEP_CAP - 2; i < SWEEP_CAP + 5; i++) expect(reads).not.toContain(secretPath(`sa_n${String(i).padStart(2, "0")}`));
  });

  it("the retention sweep never reads credentials — a failing secret read cannot stop the 30-day purge", async () => {
    await runGbpSyncSweep({ sleep: noSleep }); // caches on SA and OTHER_SA
    const real = storeDb.doc.bind(storeDb);
    const reads: string[] = [];
    vi.spyOn(storeDb, "doc").mockImplementation(((path: string) => {
      reads.push(path);
      return path.endsWith("/private/googleConnection") ? { get: () => Promise.reject(new Error("14 UNAVAILABLE")) } : real(path);
    }) as never);
    delete process.env.GBP_PROVIDER;
    const result = await runGbpRetentionSweep();
    expect(result).toMatchObject({ retained: 2, failed: 0 });
    expect(reads.filter((p) => p.endsWith("/private/googleConnection"))).toEqual([]);
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
  // access_not_approved (Google's quota-0 429) is the same project-wide wall, only permanent.
  it.each(["rate_limited", "access_not_approved"] as const)("stops starting new tenants once one gets %s", async (kind) => {
    for (const sa of ["sa_c", "sa_d", "sa_e", "sa_f"]) seedSub(sa);
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind }));
    const result = await runGbpSyncSweep({ sleep: noSleep });
    expect(result.stoppedOnRateLimit).toBe(true);
    expect(runs(SA)[0]).toMatchObject({ errorKind: kind });
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
    expect(runs(SA).find((r) => r.skipReason === "retention_only")).toMatchObject({ status: "skipped", purged: 7 });
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

describe("retention sweep outcomes are counted honestly", () => {
  it("a retention pass that THROWS records a failed retention run and is not counted as retained", async () => {
    await runGbpSyncSweep({ sleep: noSleep }); // caches on SA and OTHER_SA
    const before = mem.read(`subAccounts/${SA}`)?.gbpSummary;
    const beforeOther = mem.read(`subAccounts/${OTHER_SA}`)?.gbpSummary;
    vi.spyOn(storeDb, "runTransaction").mockRejectedValueOnce(new Error("14 UNAVAILABLE"));
    const result = await runGbpRetentionSweep();
    expect(result).toMatchObject({ retained: 1, failed: 1, refused: 0 });
    const failed = [...runs(SA), ...runs(OTHER_SA)].filter((r) => r.status === "failed");
    expect(failed).toEqual([expect.objectContaining({ skipReason: "retention_only", errorKind: "internal", trigger: "scheduled" })]);
    // A housekeeping failure never rewrites the sync summary.
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toEqual(before);
    expect(mem.read(`subAccounts/${OTHER_SA}`)?.gbpSummary).toEqual(beforeOther);
  });

  it("a pass that fails INSIDE its lease is recorded as a failed retention run and counted failed", async () => {
    await runGbpSyncSweep({ sleep: noSleep });
    const real = storeDb.collection.bind(storeDb);
    vi.spyOn(storeDb, "collection").mockImplementation(((path: string) => {
      if (path === `subAccounts/${SA}/gbpReviews`) throw new Error("14 UNAVAILABLE");
      return real(path);
    }) as never);
    expect(await runGbpRetentionSweep()).toMatchObject({ retained: 1, failed: 1, refused: 0 });
    expect(runs(SA).filter((r) => r.skipReason === "retention_only")).toEqual([
      expect.objectContaining({ status: "failed", errorKind: "internal", purged: 0 }),
    ]);
  });

  it("a pass refused by a live lease is reported as refused, not retained, and leaves no run", async () => {
    await runGbpSyncSweep({ sleep: noSleep });
    const runsBefore = runs(SA).length;
    const state = mem.read(`subAccounts/${SA}/private/gbpSyncState`) ?? {};
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, { ...state, lease: { runId: "someone", until: Date.now() + 60_000 } });
    expect(await runGbpRetentionSweep()).toMatchObject({ retained: 1, refused: 1, failed: 0 });
    expect(runs(SA)).toHaveLength(runsBefore);
  });
});

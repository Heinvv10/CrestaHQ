import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * syncListing when things go wrong: failures keep good data, cursors resume,
 * overlapping runs never duplicate, a revoked grant ends reconnect_required.
 * Same seam as run.test.ts — real fence, tokens, fake provider, store.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  NOW,
  SA,
  activeReviews,
  mem,
  recordingSleep,
  resetSync,
  reviews,
  runs,
  seedSub,
  setScenario,
  summaryOf,
  syncState,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { fakeScenarioPath } from "../provider/fake-scenario";
import { syncListing } from "./run";
import { syncStatePath } from "./types";

const ORIGINAL = { ...process.env };
let clock: ReturnType<typeof recordingSleep>;
const sync = (over: Partial<Parameters<typeof syncListing>[1]> = {}) =>
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

describe("retry and backoff", () => {
  it("retries a transient page twice with 1s then 2s, then succeeds", async () => {
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: "3", kind: "transient", times: 2 }));
    expect(await sync()).toMatchObject({ status: "success", created: 7 });
    expect(clock.waits).toEqual([1000, 2000]);
  });

  it("does not retry a non-retryable kind", async () => {
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "permission_denied", times: 1 }));
    expect(await sync()).toMatchObject({ status: "failed", errorKind: "permission_denied", pagesFetched: 0 });
    expect(clock.waits).toEqual([]);
  });
});

describe("partial failure keeps good data", () => {
  it("a page failing after retries records partial and deletes nothing", async () => {
    await sync();
    setScenario(SA, (s) => {
      s.failReviewsPage = { pageToken: "3", kind: "transient" };
      s.reviews["locations/e2e-velo-gqeberha"].reviews.pop();
    });
    const run = await sync();
    expect(run).toMatchObject({
      status: "partial", errorKind: "transient", pagesFetched: 1, reconciliation: "deferred", removed: 0,
    });
    expect(clock.waits).toEqual([1000, 2000]);
    expect(activeReviews()).toHaveLength(7);
    expect(summaryOf()).toMatchObject({ lastRunStatus: "partial", health: "partial", lastErrorKind: "transient" });
    expect((summaryOf()?.lastSuccessfulSyncAt as Date).getTime()).toBe(NOW.getTime());
    expect(syncState()?.pass).toMatchObject({ pageToken: "3", pagesDone: 1 });
  });

  it("a first page failing records failed; the prior summary becomes stale, not erased", async () => {
    await sync();
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "rate_limited" }));
    const later = new Date(NOW.getTime() + 3600_000);
    const run = await sync({ now: later });
    expect(run).toMatchObject({ status: "failed", errorKind: "rate_limited", pagesFetched: 0 });
    expect(activeReviews()).toHaveLength(7);
    expect(summaryOf()).toMatchObject({ averageRating: 3.6, totalReviewCount: 7, health: "stale" });
    // A failure never moves the last SUCCESS forward.
    expect((summaryOf()?.lastSuccessfulSyncAt as Date).getTime()).toBe(NOW.getTime());
  });

  it("honours Retry-After, capped at 10s", async () => {
    const { withRetry } = await import("./retry");
    const { GbpProviderError } = await import("../provider/types");
    let n = 0;
    await withRetry(async () => {
      n += 1;
      if (n === 1) throw new GbpProviderError("rate_limited", { retryAfterMs: 4000 });
      if (n === 2) throw new GbpProviderError("rate_limited", { retryAfterMs: 60_000 });
      return "ok";
    }, clock.sleep);
    expect(clock.waits).toEqual([4000, 10_000]);
  });
});

describe("resume", () => {
  it("resumes a young pass from its cursor, then reconciles the whole pass", async () => {
    await sync({ maxPages: 1 });
    expect(reviews()).toHaveLength(3);
    const passId = (syncState()?.pass as { passId: string }).passId;
    const run = await sync({ maxPages: 5 });
    expect(run).toMatchObject({ status: "success", resumedFromCursor: true, pagesFetched: 2, created: 4, reconciliation: "full" });
    expect(reviews()).toHaveLength(7);
    expect(new Set(reviews().map((r) => r.passId))).toEqual(new Set([passId]));
    expect(syncState()?.pass).toBeNull();
  });

  it("abandons a pass older than 24h and starts again from page 1", async () => {
    await sync({ maxPages: 1 });
    const run = await sync({ now: new Date(NOW.getTime() + 25 * 3600_000) });
    expect(run).toMatchObject({ resumedFromCursor: false, pagesFetched: 3, status: "success" });
  });

  it("restarts a stale cursor from page 1 once, keeping the pass id", async () => {
    await sync({ maxPages: 1 });
    const passId = (syncState()?.pass as { passId: string }).passId;
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, {
      lease: null, pass: { passId, pageToken: "999", pagesDone: 1, startedAt: NOW.getTime() },
    });
    const run = await sync();
    expect(run).toMatchObject({ status: "success", resumedFromCursor: true, pagesFetched: 3, reconciliation: "full" });
    expect(new Set(reviews().map((r) => r.passId))).toEqual(new Set([passId]));
    expect(activeReviews()).toHaveLength(7);
  });
});

describe("overlapping runs", () => {
  it("the second concurrent run is skipped already_running, and nothing is duplicated", async () => {
    const [a, b] = await Promise.all([sync(), sync()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["skipped", "success"]);
    expect([a, b].find((r) => r.status === "skipped")?.skipReason).toBe("already_running");
    expect(reviews()).toHaveLength(7);
    expect(runs()).toHaveLength(2);
    expect(syncState()?.lease).toBeNull();
  });

  it("a live lease blocks a run; an expired one does not", async () => {
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, { lease: { runId: "other", until: NOW.getTime() + 60_000 }, pass: null });
    expect(await sync()).toMatchObject({ status: "skipped", skipReason: "already_running" });
    expect(reviews()).toHaveLength(0);
    expect(syncState()?.lease).toMatchObject({ runId: "other" });
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, { lease: { runId: "other", until: NOW.getTime() - 1 }, pass: null });
    expect(await sync()).toMatchObject({ status: "success" });
  });
});

describe("lease lost mid-run", () => {
  it("stops writing the moment its sync state is cleared (listing changed / disconnected)", async () => {
    const real = storeDb.doc.bind(storeDb);
    let scenarioReads = 0;
    vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      // While page 2 is being fetched, the cache is cleared under the run.
      if (path === fakeScenarioPath(SA) && ++scenarioReads === 2) void real(syncStatePath(SA)).delete();
      return real(path);
    });
    const run = await sync();
    expect(run).toMatchObject({ status: "failed", errorKind: "lease_lost", pagesFetched: 1 });
    expect(reviews()).toHaveLength(3);
    expect(summaryOf()).toBeFalsy();
    expect(syncState()).toBeUndefined();
  });
});

describe("revoked grant", () => {
  it("with a still-FRESH cached token ends reconnect_required and keeps every review", async () => {
    await sync();
    setScenario(SA, (s) => void (s.revoked = true));
    const run = await sync({ now: new Date(NOW.getTime() + 60_000) });
    expect(run).toMatchObject({ status: "reconnect_required", errorKind: "revoked", removed: 0 });
    expect(activeReviews()).toHaveLength(7);
    expect(summaryOf()).toMatchObject({ health: "reconnect_required", averageRating: 3.6 });
    const meta = mem.read(`subAccounts/${SA}`)?.googleConnectionMeta as Record<string, unknown>;
    expect(meta).toMatchObject({ reconnectRequired: true, reconnectReason: "revoked" });
  });

  it("an already-flagged connection is skipped without calling Google", async () => {
    seedSub(SA, { reconnectRequired: true });
    setScenario(SA, (s) => void (s.failNext = { op: "listReviews", kind: "transient" }));
    const run = await sync();
    expect(run).toMatchObject({ status: "skipped", skipReason: "reconnect_required" });
    expect(mem.read(`subAccounts/${SA}/private/gbpFakeScenario`)?.failNext).toBeDefined();
    expect(summaryOf()).toMatchObject({ health: "reconnect_required" });
  });
});

describe("skips", () => {
  it.each([
    ["gate_off", { gateOn: false }],
    ["not_connected", { connected: false }],
    ["no_listing", { listing: null }],
  ] as const)("records %s without calling the provider", async (reason, opts) => {
    seedSub(SA, opts);
    setScenario(SA, (s) => void (s.failNext = { op: "listReviews", kind: "transient" }));
    expect(await sync()).toMatchObject({ status: "skipped", skipReason: reason, pagesFetched: 0 });
    expect(mem.read(`subAccounts/${SA}/private/gbpFakeScenario`)?.failNext).toBeDefined();
    expect(reviews()).toHaveLength(0);
    expect(runs()).toHaveLength(1);
  });
});

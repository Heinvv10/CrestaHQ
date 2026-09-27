import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/gbp/sync — "Sync now". Real require-tenancy,
 * real gate, real syncListing, real fake provider; only Firestore and Firebase
 * Auth are in-memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const handed = vi.hoisted(() => vi.fn());
// Auto-reply then sentiment run after the response; here we only see what the route hands them.
vi.mock("@/lib/reputation/after-sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/reputation/after-sync")>()),
  afterSyncResponse: handed,
}));

import {
  FOREIGN_AGENCY,
  FOREIGN_SA,
  LEAK_MARKERS,
  OTHER_SA,
  SA,
  activeReviews,
  asUser,
  mem,
  resetSync,
  reviews,
  runs,
  seedExtraListing,
  seedSub,
} from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { POST, maxDuration } from "./route";

const ORIGINAL = { ...process.env };
const url = (sa: string) => `http://127.0.0.1:3100/api/sub-accounts/${sa}/gbp/sync`;

async function syncNow(uid: string, sa = SA) {
  const res = await POST(asUser(url(sa), uid, "POST"), { params: Promise.resolve({ id: sa }) });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  return { status: res.status, body: JSON.parse(text) as Record<string, Record<string, unknown>> };
}

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("authorization", () => {
  it.each([
    ["a collaborator (read-only role)", "uid_collab"],
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s and syncs nothing", async (_l, uid) => {
    expect((await syncNow(uid)).status).toBe(403);
    expect(reviews()).toHaveLength(0);
    expect(runs()).toHaveLength(0);
  });

  it("refuses with gate_off when the agency gate is off, recording nothing", async () => {
    seedSub(SA, { gateOn: false });
    const res = await syncNow("uid_admin");
    expect(res).toEqual({ status: 403, body: { error: expect.any(String), code: "gate_off" } });
    expect(runs()).toHaveLength(0);
  });

  it("refuses in fake mode for a sub-account of another agency, writing nothing", async () => {
    seedSub(FOREIGN_SA, { agencyId: FOREIGN_AGENCY });
    mem.seed(`subAccounts/${FOREIGN_SA}/subAccountMembers/uid_admin`, { status: "active", role: "admin" });
    expect(await syncNow("uid_admin", FOREIGN_SA)).toEqual({
      status: 503, body: { error: expect.any(String), code: "not_configured" },
    });
    expect(reviews(FOREIGN_SA)).toHaveLength(0);
    expect(runs(FOREIGN_SA)).toHaveLength(0);
    expect(mem.read(`subAccounts/${FOREIGN_SA}/private/gbpSyncState`)).toBeUndefined();
  });
});

describe("an admin's Sync now", () => {
  it("runs the core inline as a manual run and returns only the public subset", async () => {
    const { status, body } = await syncNow("uid_admin");
    expect(status).toBe(200);
    expect(body.run).toEqual({
      trigger: "manual", status: "success", startedAt: expect.any(String), finishedAt: expect.any(String),
      pagesFetched: 3, reviewsSeen: 7, created: 7, updated: 0, unchanged: 0, removed: 0, purged: 0,
      reconciliation: "full", resumedFromCursor: false, errorKind: null, skipReason: null,
    });
    expect(activeReviews()).toHaveLength(7);
    expect(runs()[0]).toMatchObject({ trigger: "manual", actorUid: "uid_admin" });
    expect(reviews(OTHER_SA)).toHaveLength(0);
  });

  it("a second Sync now within a minute is refused too_soon, and runs nothing", async () => {
    expect((await syncNow("uid_admin")).status).toBe(200);
    const again = await syncNow("uid_admin");
    expect(again).toEqual({ status: 409, body: { error: expect.any(String), code: "too_soon" } });
    expect(runs()).toHaveLength(1);
  });

  it("allows Sync now again once the minute has passed", async () => {
    mem.seed(`subAccounts/${SA}/private/gbpSyncState`, { lease: null, pass: null, lastManualAt: Date.now() - 61_000 });
    expect((await syncNow("uid_admin")).status).toBe(200);
  });

  it("a sync that throws still answers JSON and records a failed run", async () => {
    // A Firestore outage on the lease transaction (after the cooldown claim).
    const real = storeDb.runTransaction.bind(storeDb);
    let n = 0;
    vi.spyOn(storeDb, "runTransaction").mockImplementation((async (fn: never) => {
      if (++n === 2) throw new Error("14 UNAVAILABLE");
      return real(fn);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await syncNow("uid_admin");
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ trigger: "manual", status: "failed", errorKind: "internal" });
    expect(runs()).toEqual([expect.objectContaining({ status: "failed", actorUid: "uid_admin" })]);
  });

  it("reports a skip as a result, not an error", async () => {
    seedSub(SA, { listing: null });
    const { status, body } = await syncNow("uid_admin");
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ status: "skipped", skipReason: "no_listing" });
  });
});

describe("auto-reply + sentiment after the response", () => {
  it("hands this run's counts and start to the after-response work", async () => {
    handed.mockClear();
    const { status } = await syncNow("uid_admin");
    expect(status).toBe(200);
    expect(handed).toHaveBeenCalledTimes(1);
    // The run's startedAt is what auto-reply's "seen by this run" compares against.
    const run = mem.list(`subAccounts/${SA}/gbpSyncRuns`)[0];
    expect(handed).toHaveBeenCalledWith(
      [{ subAccountId: SA, created: 7, updated: 0, startedAt: run.startedAt }], expect.any(Number),
    );
    // One deadline for the request: its start + 240 s.
    const deadline = handed.mock.calls[0][1] as number;
    expect(deadline - Date.now()).toBeGreaterThan(230_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(240_000);
  });
});

describe("two listings (MULTI_LISTING_V1_PLAN.md PR 2)", () => {
  it("syncs both: `run` is the main listing's, `runs` has each; ONE aggregate goes to the after-response work", async () => {
    handed.mockClear();
    seedExtraListing(SA);
    const { status, body } = await syncNow("uid_admin");
    expect(status).toBe(200);
    const all = body.runs as unknown as Array<Record<string, unknown>>;
    expect(all.map((r) => [r.status, r.created])).toEqual([["success", 7], ["success", 3]]);
    expect(body.run).toEqual(all[0]);
    const earliest = runs().map((r) => r.startedAt as Date).sort((a, b) => a.getTime() - b.getTime())[0];
    expect(handed).toHaveBeenCalledTimes(1);
    expect(handed).toHaveBeenCalledWith([{ subAccountId: SA, created: 10, updated: 0, startedAt: earliest }], expect.any(Number));
  });

  it("single listing: unchanged — `runs` is just the one run", async () => {
    const { body } = await syncNow("uid_admin");
    expect(body.runs).toEqual([body.run]);
  });
});

it("allows 300 s, so the after-response sentiment run (240 s budget) is not cut off", () => {
  expect(maxDuration).toBe(300);
});

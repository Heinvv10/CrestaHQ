import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/reputation/insights — real require-tenancy,
 * gate, token lifecycle, withGbpAccess, discovery and the fenced fake
 * provider on the in-memory Firestore. The expected numbers are computed HERE
 * from the scenario's patterns, not by the code under test.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, LOC_A, OTHER_SA, SA, asUser, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { resetInsightsMemo } from "@/lib/gbp/insights";
import { ACCESS_NOT_APPROVED_TEXT } from "@/lib/gbp/error-text";
import { GET } from "./route";

const LOC_B = "locations/e2e-velo-gqeberha-north";
const NOW = new Date("2026-09-14T10:00:00Z");
type Json = Record<string, unknown> & { groups: Record<string, { current: number; previous: number }> };

async function get(query = "", uid = "uid_admin", sa = SA) {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/reputation/insights${query}`, uid), {
    params: Promise.resolve({ id: sa }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** Day number (days since 1970-01-01 UTC) of every date in [start, end]. */
function dayNumbers(start: string, end: string): number[] {
  const out: number[] = [];
  for (let n = Date.parse(`${start}T00:00:00Z`) / 86_400_000; n <= Date.parse(`${end}T00:00:00Z`) / 86_400_000; n++) out.push(n);
  return out;
}
const sumPattern = (pattern: number[], days: number[]) => days.reduce((t, n) => t + pattern[n % pattern.length], 0);

const PATTERNS = {
  [LOC_A]: {
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [10, 20], BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [30], BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [1, 2, 3],
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: [4], CALL_CLICKS: [0, 1], WEBSITE_CLICKS: [2], BUSINESS_DIRECTION_REQUESTS: [1, 0, 0],
    BUSINESS_CONVERSATIONS: [0], BUSINESS_BOOKINGS: [0],
  },
  [LOC_B]: {
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [5], BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [6], BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [7],
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: [8], CALL_CLICKS: [3], WEBSITE_CLICKS: [0], BUSINESS_DIRECTION_REQUESTS: [2],
    BUSINESS_CONVERSATIONS: [1], BUSINESS_BOOKINGS: [1, 0],
  },
};

beforeEach(() => {
  resetSync();
  resetInsightsMemo();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setScenario(SA, (s) => void (s.insights = PATTERNS));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("numbers", () => {
  it("serves the listing's totals, previous totals and daily series for 28d by default — for any member", async () => {
    const { status, body } = await get("", "uid_collab");
    expect(status).toBe(200);
    const cur = dayNumbers("2026-08-17", "2026-09-13");
    const prev = dayNumbers("2026-07-20", "2026-08-16");
    const p = PATTERNS[LOC_A];
    expect(body.range).toBe("28d");
    expect(body.window).toEqual({ current: { start: "2026-08-17", end: "2026-09-13" }, previous: { start: "2026-07-20", end: "2026-08-16" } });
    expect(body.location).toEqual({ name: LOC_A, title: "Velo Test Fibre — Gqeberha", isListing: true });
    expect(body.groups.searchViews).toEqual({
      current: sumPattern(p.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, cur) + sumPattern(p.BUSINESS_IMPRESSIONS_MOBILE_SEARCH, cur),
      previous: sumPattern(p.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, prev) + sumPattern(p.BUSINESS_IMPRESSIONS_MOBILE_SEARCH, prev),
    });
    expect(body.groups.mapsViews.current).toBe(sumPattern(p.BUSINESS_IMPRESSIONS_DESKTOP_MAPS, cur) + 4 * 28);
    expect(body.groups.calls.current).toBe(sumPattern(p.CALL_CLICKS, cur));
    expect(body.groups.websiteClicks).toEqual({ current: 56, previous: 56 });
    expect(body.groups.directions.current).toBe(sumPattern(p.BUSINESS_DIRECTION_REQUESTS, cur));
    expect(body.groups.desktopViews.current).toBe(sumPattern(p.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, cur) + sumPattern(p.BUSINESS_IMPRESSIONS_DESKTOP_MAPS, cur));
    expect(body.groups.bookings).toEqual({ current: 0, previous: 0 });
    expect((body.daily as unknown[]).length).toBe(28);
    expect(body.lastDataDate).toBe("2026-09-13");
  });

  it.each([
    ["7d", "2026-09-07"],
    ["90d", "2026-06-16"],
  ])("range=%s covers the right days", async (range, start) => {
    const { body } = await get(`?range=${range}`);
    expect((body.window as { current: { start: string } }).current.start).toBe(start);
    expect(body.groups.mobileViews.current).toBe(30 * Number(range.replace("d", "")) + 4 * Number(range.replace("d", "")));
  });

  it("an admin may view another location this connection can see — other numbers, and the review listing is untouched", async () => {
    const before = JSON.stringify(mem.read(`subAccounts/${SA}`)?.googleListing);
    const { status, body } = await get(`?location=${encodeURIComponent(LOC_B)}&range=7d`);
    expect(status).toBe(200);
    expect(body.location).toEqual({ name: LOC_B, title: "Velo Test Fibre — Gqeberha North", isListing: false });
    expect(body.groups.calls.current).toBe(21);
    expect(body.groups.bookings.current).toBe(sumPattern([1, 0], dayNumbers("2026-09-07", "2026-09-13")));
    expect(JSON.stringify(mem.read(`subAccounts/${SA}`)?.googleListing)).toBe(before);
  });

  it("stores nothing: no metrics in Firestore, the sub-account doc unchanged", async () => {
    const sub = JSON.stringify(mem.read(`subAccounts/${SA}`));
    await get(`?location=${encodeURIComponent(LOC_B)}`);
    expect(JSON.stringify(mem.read(`subAccounts/${SA}`))).toBe(sub);
    const dump = JSON.stringify(mem.list(`subAccounts/${SA}/gbpReviews`)) + JSON.stringify(mem.list("gbpInsights"));
    expect(dump).not.toMatch(/IMPRESSIONS|CALL_CLICKS|searchViews/);
  });
});

describe("the location is never trusted", () => {
  it.each([
    ["not visible to this connection", "locations/somebody-else", "unknown_location"],
    ["malformed", "locations/a/../b", "unknown_location"],
    ["an account path", `${ACCOUNT}/${LOC_A}`, "unknown_location"],
  ])("refuses a location %s with 400 %s", async (_label, location, code) => {
    const { status, body } = await get(`?location=${encodeURIComponent(location)}`);
    expect(status).toBe(400);
    expect(body.code).toBe(code);
  });

  it("refuses a malformed location before any Google call", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "listAccounts", kind: "transient" }));
    const { status, body } = await get(`?location=${encodeURIComponent("locations/a/../b")}`);
    expect(status).toBe(400);
    expect(body.code).toBe("unknown_location");
    // The scripted failure is still armed: discovery never ran.
    expect((mem.read(`subAccounts/${SA}/private/gbpFakeScenario`) as { failNext?: unknown }).failNext).toBeTruthy();
  });

  it("refuses with unverifiable_truncated when the walk stopped before finding it", async () => {
    setScenario(SA, (s) => {
      s.accounts = Array.from({ length: 61 }, (_, i) => ({ name: `accounts/fx-${i}`, accountName: `Fixture ${i}`, type: "LOCATION_GROUP" }));
      s.locations = { ...s.locations, "accounts/fx-60": [{ ...s.locations[ACCOUNT][1] }] };
    });
    const { status, body } = await get(`?location=${encodeURIComponent(LOC_B)}`);
    expect(status).toBe(400);
    expect(body.code).toBe("unverifiable_truncated");
  });

  it("a member (not admin) may see only the selected listing", async () => {
    const { status } = await get(`?location=${encodeURIComponent(LOC_B)}`, "uid_collab");
    expect(status).toBe(403);
    expect((await get(`?location=${encodeURIComponent(LOC_A)}`, "uid_collab")).status).toBe(200);
  });
});

describe("refusals", () => {
  it("400 invalid_filter for an unknown range", async () => {
    const { status, body } = await get("?range=30d");
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_filter", field: "range" });
  });

  it("403 for a non-member and for another sub-account's admin", async () => {
    expect((await get("", "uid_stranger")).status).toBe(403);
    expect((await get("", "uid_other_admin")).status).toBe(403);
    expect((await get("", "uid_other_admin", OTHER_SA)).status).toBe(200);
  });

  it.each([
    ["gate off", { googleEnabledByAgency: false }, 403, "gate_off"],
    ["not connected", { googleConnectionMeta: null }, 409, "not_connected"],
    ["reconnect required", { googleConnectionMeta: { connected: true, reconnectRequired: true } }, 409, "reconnect_required"],
    ["no listing", { googleListing: null }, 409, "no_listing"],
  ])("%s → %i %s", async (_label, patch, status, code) => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, ...patch });
    const res = await get();
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it("Google's quota-0 refusal → 424 access_not_approved with the fixed sentence", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "fetchDailyMetrics", kind: "access_not_approved" }));
    const { status, body } = await get();
    expect(status).toBe(424);
    expect(body).toEqual({ code: "access_not_approved", error: ACCESS_NOT_APPROVED_TEXT });
  });
});

describe("the in-memory memo (10 min per sub-account + connection + location + range)", () => {
  it("serves a repeat from memory, then asks Google again after 10 minutes", async () => {
    await get();
    setScenario(SA, (s) => void (s.failNext = { op: "fetchDailyMetrics", kind: "transient" }));
    expect((await get()).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000 + 1));
    expect((await get()).status).toBe(424);
  });

  it("is keyed by location and range, and by the connection — a reconnect asks again", async () => {
    await get();
    setScenario(SA, (s) => void (s.failNext = { op: "fetchDailyMetrics", kind: "transient" }));
    expect((await get("?range=7d")).status).toBe(424);
    await get();
    setScenario(SA, (s) => void (s.failNext = { op: "fetchDailyMetrics", kind: "transient" }));
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleConnectionMeta: { ...(sub.googleConnectionMeta as object), connectedAt: new Date(NOW.getTime() + 1) } });
    expect((await get()).status).toBe(424);
  });

  it("never memoises a refusal", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "fetchDailyMetrics", kind: "transient" }));
    expect((await get()).status).toBe(424);
    expect((await get()).status).toBe(200);
  });
});

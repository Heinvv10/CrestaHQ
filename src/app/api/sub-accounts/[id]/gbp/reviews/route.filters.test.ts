import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/gbp/reviews — the inbox filters. Applied in
 * memory over the capped newest-first set (no composite index), through the
 * real route, tenancy and fake-provider sync.
 *
 * Fixture (newest first): r7 5★ replied 08-27 · r6 2★ 08-24 · r5 3★ 08-21 ·
 * r4 5★ 08-18 · r3 4★ replied 08-15 · r2 1★ 08-12 · r1 5★ 08-09.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LEAK_MARKERS, LOC_A, SA, asUser, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

async function read(query: string) {
  const res = await GET(
    asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/reviews${query}`, "uid_admin"),
    { params: Promise.resolve({ id: SA }) },
  );
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  const body = JSON.parse(text) as {
    reviews?: Array<{ reviewId: string }>;
    available?: number;
    code?: string;
    field?: string;
  };
  return { status: res.status, body, ids: (body.reviews ?? []).map((r) => r.reviewId) };
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("filters", () => {
  it("without filters returns every active review newest first, and how many there are", async () => {
    const { ids, body } = await read("");
    expect(ids).toEqual(["fake-r7", "fake-r6", "fake-r5", "fake-r4", "fake-r3", "fake-r2", "fake-r1"]);
    expect(body.available).toBe(7);
  });

  it("rating: a comma list of stars", async () => {
    expect((await read("?rating=1,2")).ids).toEqual(["fake-r6", "fake-r2"]);
    expect((await read("?rating=5")).ids).toEqual(["fake-r7", "fake-r4", "fake-r1"]);
  });

  it("replied: replied / unreplied / all", async () => {
    expect((await read("?replied=replied")).ids).toEqual(["fake-r7", "fake-r3"]);
    expect((await read("?replied=unreplied")).ids).toEqual(["fake-r6", "fake-r5", "fake-r4", "fake-r2", "fake-r1"]);
    expect((await read("?replied=all")).ids).toHaveLength(7);
  });

  it("from / to on createTime, a date-only `to` covering that whole day", async () => {
    expect((await read("?from=2026-08-15&to=2026-08-21")).ids).toEqual(["fake-r5", "fake-r4", "fake-r3"]);
    expect((await read("?from=2026-08-24")).ids).toEqual(["fake-r7", "fake-r6"]);
    expect((await read("?to=2026-08-12")).ids).toEqual(["fake-r2", "fake-r1"]);
    expect((await read("?from=2026-08-21T09:00:01Z")).ids).toEqual(["fake-r7", "fake-r6"]);
  });

  it("sort: oldest first on request", async () => {
    expect((await read("?sort=oldest")).ids).toEqual(["fake-r1", "fake-r2", "fake-r3", "fake-r4", "fake-r5", "fake-r6", "fake-r7"]);
    expect((await read("?sort=newest")).ids[0]).toBe("fake-r7");
  });

  it("combines filters, and still reports the unfiltered count", async () => {
    const { ids, body } = await read("?rating=5&replied=unreplied&sort=oldest");
    expect(ids).toEqual(["fake-r1", "fake-r4"]);
    expect(body.available).toBe(7);
  });

  it("ignores an empty value, as a form with a blank date sends it", async () => {
    expect((await read("?from=&to=&rating=")).ids).toHaveLength(7);
  });
});

describe("validation", () => {
  it.each([
    ["rating=0", "rating"],
    ["rating=6", "rating"],
    ["rating=abc", "rating"],
    ["rating=1,,2", "rating"],
    ["rating=4.5", "rating"],
    ["replied=maybe", "replied"],
    ["from=yesterday", "from"],
    ["from=Aug 21 2026", "from"],
    ["to=2026-13-40", "to"],
    ["to=2026-02-31", "to"],
    ["sort=random", "sort"],
    ["from=2026-08-21&to=2026-08-15", "to"],
  ])("400 on %s", async (query, field) => {
    const { status, body } = await read(`?${query}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_filter", field });
  });
});

describe("local days (the page sends local midnights with their offset)", () => {
  it("a UTC+2 user's day runs local midnight to local midnight — a 23:30Z review belongs to the next local day", async () => {
    setScenario(SA, (s) => {
      const r6 = s.reviews[LOC_A].reviews[1];
      const late = {
        ...r6, name: r6.name.replace("fake-r6", "fake-late"), reviewId: "fake-late",
        createTime: "2026-08-23T23:30:00Z", updateTime: "2026-08-23T23:30:00Z", reply: null,
      };
      s.reviews[LOC_A].reviews.splice(2, 0, late);
      s.reviews[LOC_A].totalReviewCount = 8;
    });
    await syncListing(SA, { trigger: "scheduled" });
    // 24 Aug in UTC+2: 23 Aug 22:00Z up to (not including) 24 Aug 22:00Z.
    expect((await read("?from=2026-08-24T00:00:00%2B02:00&to=2026-08-25T00:00:00%2B02:00")).ids).toEqual(["fake-r6", "fake-late"]);
    // The UTC day would have dropped it.
    expect((await read("?from=2026-08-24")).ids).not.toContain("fake-late");
    // A date-time `to` is exclusive: 01:30+02:00 IS 23:30Z.
    expect((await read("?from=2026-08-24T00:00:00%2B02:00&to=2026-08-24T01:30:00%2B02:00")).ids).toEqual([]);
  });
});

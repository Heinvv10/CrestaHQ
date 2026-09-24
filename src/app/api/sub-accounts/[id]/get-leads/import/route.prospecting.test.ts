import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/get-leads/import — the Prospecting additions:
 * new imports are `source: "prospecting"` with the `prospecting` map, and an
 * optional `listId` stamps the saved list on every contact. A `listId` needs
 * the Prospecting gate and a list owned by THIS sub-account. Real tenancy and
 * the real contacts service on an in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const GATE_OFF = { error: "Prospecting is locked by your agency.", code: "gate_off" };

const ROW_A = {
  placeId: "ChIJplumberA",
  googlePlaceId: "ChIJplumberA",
  name: "Aqua Plumbing",
  category: "Plumber",
  fullAddress: "1 Main Rd, Gqeberha",
  city: "Gqeberha",
  phone: "+27 41 555 0101",
  website: "https://aqua.example",
  email: "hello@aqua.example",
  rating: 4.6,
  reviewsCount: 87,
  latitude: -33.96,
  longitude: 25.6,
};
// No Google place id on the row: the page's synthesized key must not be stored.
const ROW_B = {
  ...ROW_A,
  placeId: "Blue Pipes:-33.9,25.5",
  googlePlaceId: null,
  name: "Blue Pipes",
  phone: "+27 41 555 0202",
  email: null,
  website: null,
  rating: null,
  reviewsCount: null,
  category: null,
};

function post(body: unknown, sa = "sa1", uid = "admin1") {
  return POST(
    new Request(`https://app.test/api/sub-accounts/${sa}/get-leads/import`, {
      method: "POST",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: sa }) },
  );
}

const contacts = () => mem.list("contacts");

function seedSa(sa: string, prospecting: boolean) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    getLeadsEnabledByAgency: true,
    prospectingEnabledByAgency: prospecting,
  });
}

beforeEach(() => {
  mem.clear();
  claims.clear();
  seedSa("sa1", true);
  seedSa("sa2", true);
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  const list = { agencyId: "ag1", createdByUid: "x", name: "L", count: 2, query: {} };
  mem.seed("prospectLists/list1", { ...list, subAccountId: "sa1" });
  mem.seed("prospectLists/list2", { ...list, subAccountId: "sa2" });
});

describe("import writes a prospect", () => {
  it("source, tags, tenancy keys and the prospecting map (no listId: Get Leads gate only)", async () => {
    seedSa("sa1", false);
    const res = await post({ businesses: [ROW_A, ROW_B], tag: "Plumbers Gqeberha" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 2, skipped: [] });
    const [a, b] = ["Aqua Plumbing", "Blue Pipes"].map((n) => contacts().find((c) => c.name === n)!);
    for (const c of [a, b]) {
      expect(c).toMatchObject({
        agencyId: "ag1",
        subAccountId: "sa1",
        createdByUid: "admin1",
        source: "prospecting",
        tags: ["prospecting", "plumbers-gqeberha"],
      });
    }
    expect(a.prospecting).toEqual({
      placeId: "ChIJplumberA",
      website: "https://aqua.example",
      rating: 4.6,
      reviewsCount: 87,
      category: "Plumber",
      approachedAt: null,
      lastReportId: null,
    });
    expect(b.prospecting).toEqual({ approachedAt: null, lastReportId: null });
  });

  it("stamps listId on every contact of an import that names this sub-account's list", async () => {
    const res = await post({ businesses: [ROW_A, ROW_B], tag: "x", listId: "list1" });
    expect(res.status).toBe(200);
    expect(contacts()).toHaveLength(2);
    for (const c of contacts()) {
      expect((c.prospecting as { listId?: string }).listId).toBe("list1");
    }
  });
});

describe("listId guards", () => {
  it("403 gate_off when a listId is sent while Prospecting is off; nothing written", async () => {
    seedSa("sa1", false);
    const res = await post({ businesses: [ROW_A], listId: "list1" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(GATE_OFF);
    expect(contacts()).toEqual([]);
  });

  it("404s another sub-account's list exactly like a missing one; nothing written", async () => {
    const theirs = await post({ businesses: [ROW_A], listId: "list2" });
    const missing = await post({ businesses: [ROW_A], listId: "no-such-list" });
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
    expect(contacts()).toEqual([]);
  });

  it("400s a listId that is not a non-empty string", async () => {
    expect((await post({ businesses: [ROW_A], listId: 7 })).status).toBe(400);
    expect((await post({ businesses: [ROW_A], listId: "" })).status).toBe(400);
    expect(contacts()).toEqual([]);
  });

  it("400s a listId with a slash before any list lookup (db.doc would throw on it)", async () => {
    const { storeDb } = await import("@/test/gbp-sync-store");
    const docSpy = vi.spyOn(storeDb, "doc");
    for (const listId of ["a/b", "list1/x", "/", "  "]) {
      expect((await post({ businesses: [ROW_A], listId })).status).toBe(400);
    }
    expect(docSpy.mock.calls.filter(([p]) => String(p).startsWith("prospectLists"))).toEqual([]);
    docSpy.mockRestore();
    expect(contacts()).toEqual([]);
  });

  it("still needs the Get Leads gate", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
    expect((await post({ businesses: [ROW_A], listId: "list1" })).status).toBe(403);
    expect(contacts()).toEqual([]);
  });
});

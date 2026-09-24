import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET/POST /api/sub-accounts/[id]/prospecting/lists — saved prospect lists.
 * Real tenancy on an in-memory Firestore: the gate, the member check and the
 * tenancy keys on the written doc are all exercised through the route.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem, claims } = await import("@/test/gbp-sync-store");
const { GET, POST } = await import("./route");

const GATE_OFF = { error: "Prospecting is locked by your agency.", code: "gate_off" };

const QUERY = { businessType: "plumber", placeName: "Gqeberha, Eastern Cape", lat: -33.96, lng: 25.6, radiusKm: 10 };
const LIST = { name: "Plumbers Gqeberha", query: QUERY, count: 20 };

function call(method: "GET" | "POST", sa: string, uid: string, body?: unknown) {
  const req = new Request(`https://app.test/api/sub-accounts/${sa}/prospecting/lists`, {
    method,
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = { params: Promise.resolve({ id: sa }) };
  return method === "GET" ? GET(req, ctx) : POST(req, ctx);
}

function seedSa(sa: string, gateOn: boolean) {
  mem.seed(`subAccounts/${sa}`, { agencyId: "ag1", prospectingEnabledByAgency: gateOn });
}

beforeEach(() => {
  mem.clear();
  claims.clear();
  seedSa("sa1", true);
  seedSa("sa2", true);
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  mem.seed("subAccounts/sa2/subAccountMembers/admin2", { status: "active", role: "admin" });
  claims.set("admin2", { status: "active", agencyId: "ag1", agencyRole: null });
});

describe("gate", () => {
  it.each([[undefined], [false]])("POST answers 403 gate_off while the gate is %s, and writes nothing", async (gate) => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", ...(gate === undefined ? {} : { prospectingEnabledByAgency: gate }) });
    const res = await call("POST", "sa1", "admin1", LIST);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(GATE_OFF);
    expect(mem.list("prospectLists")).toEqual([]);
  });

  it("GET answers 403 gate_off while the gate is off", async () => {
    seedSa("sa1", false);
    const res = await call("GET", "sa1", "admin1");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(GATE_OFF);
  });
});

describe("POST", () => {
  it("creates the list with the tenancy keys and returns its id", async () => {
    const res = await call("POST", "sa1", "admin1", LIST);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const doc = mem.read(`prospectLists/${id}`);
    expect(doc).toMatchObject({
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "admin1",
      name: "Plumbers Gqeberha",
      query: QUERY,
      count: 20,
    });
    expect(doc?.createdAt).toBeInstanceOf(Date);
  });

  it("refuses a non-member", async () => {
    const res = await call("POST", "sa1", "admin2", LIST);
    expect(res.status).toBe(403);
    expect(mem.list("prospectLists")).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["empty name", { ...LIST, name: "  " }],
    ["name over 100 chars", { ...LIST, name: "x".repeat(101) }],
    ["missing query", { name: "A", count: 1 }],
    ["blank business type", { ...LIST, query: { ...QUERY, businessType: "" } }],
    ["place name not a string", { ...LIST, query: { ...QUERY, placeName: 5 } }],
    ["place name over 200 chars", { ...LIST, query: { ...QUERY, placeName: "p".repeat(201) } }],
    ["latitude out of range", { ...LIST, query: { ...QUERY, lat: 91 } }],
    ["longitude not a number", { ...LIST, query: { ...QUERY, lng: "25" } }],
    ["radius not positive", { ...LIST, query: { ...QUERY, radiusKm: 0 } }],
    ["radius over 50 km", { ...LIST, query: { ...QUERY, radiusKm: 51 } }],
    ["fractional count", { ...LIST, count: 2.5 }],
    ["count over the result limit", { ...LIST, count: 41 }],
    ["negative count", { ...LIST, count: -1 }],
  ])("400s on %s", async (_label, body) => {
    const res = await call("POST", "sa1", "admin1", body);
    expect(res.status).toBe(400);
    expect(mem.list("prospectLists")).toEqual([]);
  });
});

describe("GET", () => {
  it("lists only this sub-account's lists, newest first", async () => {
    mem.seed("prospectLists/old", { agencyId: "ag1", subAccountId: "sa1", createdByUid: "admin1", ...LIST, name: "Old", createdAt: new Date("2026-09-01T00:00:00Z") });
    mem.seed("prospectLists/new", { agencyId: "ag1", subAccountId: "sa1", createdByUid: "admin1", ...LIST, name: "New", createdAt: new Date("2026-09-20T00:00:00Z") });
    mem.seed("prospectLists/theirs", { agencyId: "ag1", subAccountId: "sa2", createdByUid: "admin2", ...LIST, name: "Theirs", createdAt: new Date("2026-09-21T00:00:00Z") });
    const res = await call("GET", "sa1", "admin1");
    expect(res.status).toBe(200);
    const { lists } = (await res.json()) as { lists: { id: string; name: string; createdAt: string | null }[] };
    expect(lists.map((l) => l.id)).toEqual(["new", "old"]);
    expect(lists[0]).toMatchObject({ name: "New", query: QUERY, count: 20, createdAt: "2026-09-20T00:00:00.000Z" });
  });
});

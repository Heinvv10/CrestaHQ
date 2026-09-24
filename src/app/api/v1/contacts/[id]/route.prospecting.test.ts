import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/v1/contacts/:id — the `prospecting` map over the public API (the
 * target ApexSignal's push writes to). PATCH accepts it hand-validated: only
 * the eight known keys, typed and bounded; GET and the PATCH response return
 * it (null when the contact has none). Real route + contacts service on an
 * in-memory Firestore; only the API-key auth wrapper is stubbed.
 */

const CTX = {
  agencyId: "ag1",
  subAccountId: "sa1",
  keyId: "key1",
  keyPrefix: "lsk_abcd",
  // Test mode: no workflow enrolment to reserve, so the store stays small.
  mode: "test" as const,
  scopes: ["admin"],
  requestId: "req_test",
  apiVersion: "2026-01-01",
};

vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request, routeCtx: { params: Promise<{ id: string }> }) => {
      const rawBody = await request.text();
      return handler({
        request,
        params: await routeCtx.params,
        body: rawBody ? JSON.parse(rawBody) : null,
        rawBody,
        ctx: CTX,
      });
    },
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { GET, PATCH } = await import("./route");

const params = { params: Promise.resolve({ id: "c1" }) };
const patch = (body: unknown) =>
  PATCH(new Request("https://app.test/api/v1/contacts/c1", { method: "PATCH", body: JSON.stringify(body) }), params) as unknown as Promise<Response>;
const get = () => GET(new Request("https://app.test/api/v1/contacts/c1"), params) as unknown as Promise<Response>;

/** What a caller may write: approached_at / last_report_id are read-only. */
const WIRE = {
  list_id: "list1",
  place_id: "ChIJplumberA",
  website: "https://aqua.example",
  rating: 4.6,
  reviews_count: 87,
  category: "Plumber",
};
/** What GET returns for it: the read-only keys come back null. */
const WIRE_OUT = { ...WIRE, approached_at: null, last_report_id: null };
const STORED = {
  listId: "list1",
  placeId: "ChIJplumberA",
  website: "https://aqua.example",
  rating: 4.6,
  reviewsCount: 87,
  category: "Plumber",
};

const seedSa = (prospecting: boolean) =>
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: prospecting });

beforeEach(() => {
  mem.clear();
  seedSa(true);
  const list = { agencyId: "ag1", createdByUid: "x", name: "L", count: 1, query: {} };
  mem.seed("prospectLists/list1", { ...list, subAccountId: "sa1" });
  mem.seed("prospectLists/list2", { ...list, subAccountId: "sa2" });
  mem.seed("contacts/c1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "admin1",
    mode: "test",
    name: "Aqua Plumbing",
    email: "",
    phone: "",
    tags: [],
    source: "prospecting",
  });
});

describe("prospecting over v1", () => {
  it("returns null for a contact without the map", async () => {
    const body = (await (await get()).json()) as { contact: { prospecting: unknown } };
    expect(body.contact.prospecting).toBeNull();
  });

  it("PATCH accepts the map, stores it camelCase, and it round-trips through GET", async () => {
    const res = await patch({ prospecting: WIRE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contact: { prospecting: unknown } }).contact.prospecting).toEqual(WIRE_OUT);
    expect(mem.read("contacts/c1")?.prospecting).toEqual(STORED);
    const back = (await (await get()).json()) as { contact: { prospecting: unknown } };
    expect(back.contact.prospecting).toEqual(WIRE_OUT);
  });

  it("accepts a partial map", async () => {
    expect((await patch({ prospecting: { place_id: "ChIJx", rating: 0 } })).status).toBe(200);
    expect(mem.read("contacts/c1")?.prospecting).toEqual({ placeId: "ChIJx", rating: 0 });
  });

  it("refuses an unknown key with the file's 400, writing nothing", async () => {
    const res = await patch({ prospecting: { ...WIRE, score: 3 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_body");
    expect(body.error.message).toMatch(/score/);
    expect(mem.read("contacts/c1")?.prospecting).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["not an object", "ChIJ"],
    ["an array", [WIRE]],
    ["null", null],
    ["list_id not a string", { list_id: 5 }],
    ["place_id over 200 chars", { place_id: "p".repeat(201) }],
    ["category over 200 chars", { category: "c".repeat(201) }],
    ["website over 300 chars", { website: `https://${"w".repeat(300)}` }],
    ["rating above 5", { rating: 5.1 }],
    ["rating below 0", { rating: -1 }],
    ["rating a string", { rating: "4" }],
    ["reviews_count negative", { reviews_count: -1 }],
    ["reviews_count fractional", { reviews_count: 1.5 }],
    ["list_id empty", { list_id: "" }],
    ["list_id blank", { list_id: "  " }],
    ["list_id with a slash", { list_id: "list1/x" }],
  ])("refuses %s with 400, writing nothing", async (_label, value) => {
    const res = await patch({ prospecting: value });
    expect(res.status).toBe(400);
    expect(mem.read("contacts/c1")?.prospecting).toBeUndefined();
  });
});

describe("prospecting over v1: guards", () => {
  type ErrBody = { error: { type: string; code: string; message: string } };

  it("403 gate_off when the sub-account's Prospecting gate is off; nothing written", async () => {
    seedSa(false);
    const res = await patch({ prospecting: { website: "https://x.example" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrBody).error).toMatchObject({ type: "permission_error", code: "gate_off" });
    expect(mem.read("contacts/c1")?.prospecting).toBeUndefined();
  });

  it("a PATCH without prospecting does not need the gate", async () => {
    seedSa(false);
    expect((await patch({ name: "Aqua Plumbing (Pty)" })).status).toBe(200);
  });

  it("404s another sub-account's list exactly like a missing one; nothing written", async () => {
    const theirs = await patch({ prospecting: { list_id: "list2" } });
    const missing = await patch({ prospecting: { list_id: "no-such-list" } });
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
    expect(mem.read("contacts/c1")?.prospecting).toBeUndefined();
  });

  it.each(["approached_at", "last_report_id"])("400s %s even as null (read-only)", async (key) => {
    for (const value of [null, "2026-09-24T00:00:00Z"]) {
      const res = await patch({ prospecting: { website: "https://x.example", [key]: value } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrBody).error.message).toBe(
        `\`prospecting.${key}\` is set by LeadStack and cannot be written.`,
      );
    }
    expect(mem.read("contacts/c1")?.prospecting).toBeUndefined();
  });

  it("merges: a PATCH of only website keeps listId, approachedAt and lastReportId", async () => {
    const approachedAt = new Date("2026-09-20T08:00:00Z");
    mem.seed("contacts/c1", {
      ...mem.read("contacts/c1"),
      prospecting: { listId: "list1", placeId: "ChIJold", website: "https://old.example", approachedAt, lastReportId: "r1" },
    });
    const res = await patch({ prospecting: { website: "https://new.example" } });
    expect(res.status).toBe(200);
    expect(mem.read("contacts/c1")?.prospecting).toEqual({
      listId: "list1",
      placeId: "ChIJold",
      website: "https://new.example",
      approachedAt,
      lastReportId: "r1",
    });
    const out = ((await res.json()) as { contact: { prospecting: Record<string, unknown> } }).contact.prospecting;
    expect(out).toMatchObject({ list_id: "list1", approached_at: "2026-09-20T08:00:00.000Z", last_report_id: "r1" });
  });
});

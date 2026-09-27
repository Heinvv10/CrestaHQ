import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/sub-accounts/[id]/apexgeo-connection (+ /test). Real tenancy on the
 * in-memory Firestore; only `publicFetch` (the one way out) is faked, so the
 * real ApexGEO client runs. Every refusal must write nothing, and no
 * response may carry the key.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const fetchMock = vi.fn();
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch: (...a: unknown[]) => fetchMock(...a) }));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { PUT, DELETE } = await import("./route");
const { POST: TEST } = await import("./test/route");
const { RESPONSES } = await import("@/lib/prospecting/apexgeo.fixture");

const KEY = "apx_live_abcdef123456";
const SECRET = "subAccounts/sa1/private/apexgeoConnection";
const ctx = (id = "sa1") => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, uid = "admin1", sa = "sa1") =>
  new Request(`https://app.test/api/sub-accounts/${sa}/apexgeo-connection`, {
    method,
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const reply = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status });
const LIST_OK = { status: 200, body: { data: [], pagination: { next_cursor: null } } };

async function text(res: Response) {
  const t = await res.clone().text();
  expect(t).not.toContain(KEY);
  expect(t).not.toContain(KEY.slice(0, 12));
  return JSON.parse(t) as Record<string, unknown>;
}

beforeEach(() => {
  mem.clear();
  claims.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchMock.mockReset().mockResolvedValue(reply(LIST_OK));
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Two" });
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  mem.seed("subAccounts/sa1/subAccountMembers/member1", { status: "active", role: "member" });
  mem.seed("subAccounts/sa2/subAccountMembers/admin2", { status: "active", role: "admin" });
  for (const uid of ["admin1", "member1", "admin2"]) claims.set(uid, { status: "active", agencyId: "ag1", agencyRole: null });
});

describe("tenancy", () => {
  it.each([
    ["a plain member", "member1", "sa1"],
    ["another sub-account's admin", "admin2", "sa1"],
  ])("%s cannot connect, remove or test; nothing is written or fetched", async (_n, uid, sa) => {
    expect((await PUT(req("PUT", { apiKey: KEY }, uid, sa), ctx(sa))).status).toBe(403);
    expect((await DELETE(req("DELETE", undefined, uid, sa), ctx(sa))).status).toBe(403);
    expect((await TEST(req("POST", { apiKey: KEY }, uid, sa), ctx(sa))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SECRET)).toBeUndefined();
    expect(mem.read("subAccounts/sa1")).toEqual({ agencyId: "ag1", name: "One" });
  });
});

describe("PUT — connect", () => {
  it("checks the key with a free read, then stores it privately and only status on the parent", async () => {
    const res = await PUT(req("PUT", { apiKey: ` ${KEY} ` }), ctx());
    expect(res.status).toBe(200);
    expect(await text(res)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://apexgeo.app/api/v1/scans?limit=1");
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${KEY}` } });
    expect(mem.read(SECRET)).toEqual({ apiKey: KEY, baseUrl: "https://apexgeo.app" });
    const sub = mem.read("subAccounts/sa1")!;
    expect(sub).toMatchObject({ apexgeoConnected: true, apexgeoKeyLast4: "3456", apexgeoBaseUrl: null });
    expect(JSON.stringify(sub)).not.toContain(KEY);
  });

  it("a custom https base URL is used for the check and recorded (normalised)", async () => {
    await PUT(req("PUT", { apiKey: KEY, baseUrl: "https://geo.example.com/base/" }), ctx());
    expect(fetchMock.mock.calls[0][0]).toBe("https://geo.example.com/base/api/v1/scans?limit=1");
    expect(mem.read(SECRET)?.baseUrl).toBe("https://geo.example.com/base");
    expect(mem.read("subAccounts/sa1")?.apexgeoBaseUrl).toBe("https://geo.example.com/base");
  });

  it.each([
    "http://geo.example.com",
    "ftp://geo.example.com",
    "https://user:pw@geo.example.com",
    "https://geo.example.com/?x=1",
    "not a url",
    42,
  ])("refuses base URL %s before any fetch, writing nothing", async (baseUrl) => {
    const res = await PUT(req("PUT", { apiKey: KEY, baseUrl }), ctx());
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SECRET)).toBeUndefined();
  });

  it.each([undefined, "", "   ", "two words"])("refuses api key %j", async (apiKey) => {
    expect((await PUT(req("PUT", { apiKey }), ctx())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a key ApexGEO refuses is never stored", async () => {
    fetchMock.mockResolvedValue(reply(RESPONSES.unauthorized));
    const res = await PUT(req("PUT", { apiKey: KEY }), ctx());
    expect(res.status).toBe(400);
    expect((await text(res)).error).toMatch(/refused this key/);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(mem.read("subAccounts/sa1")).not.toHaveProperty("apexgeoConnected");
  });

  it("ApexGEO unreachable (or a private address refused) is 502 and stores nothing", async () => {
    fetchMock.mockRejectedValue(new Error("Refused: 10.0.0.1 is not a public internet address."));
    const res = await PUT(req("PUT", { apiKey: KEY, baseUrl: "https://internal.example" }), ctx());
    expect(res.status).toBe(502);
    expect((await text(res)).error).toBe("Couldn't reach ApexGEO at internal.example.");
    expect(mem.read(SECRET)).toBeUndefined();
  });
});

describe("DELETE — remove", () => {
  it("deletes the private doc and clears the status", async () => {
    await PUT(req("PUT", { apiKey: KEY }), ctx());
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(mem.read(SECRET)).toBeUndefined();
    expect(mem.read("subAccounts/sa1")).toMatchObject({ apexgeoConnected: false, apexgeoKeyLast4: null, apexgeoBaseUrl: null });
  });
});

describe("POST /test", () => {
  it("tests a pasted key without saving it", async () => {
    const res = await TEST(req("POST", { apiKey: KEY }), ctx());
    expect(await text(res)).toEqual({ ok: true, reason: null });
    expect(fetchMock.mock.calls[0][0]).toBe("https://apexgeo.app/api/v1/scans?limit=1");
    expect(mem.read(SECRET)).toBeUndefined();
  });

  it("with no body, tests the stored key", async () => {
    mem.seed(SECRET, { apiKey: KEY, baseUrl: "https://geo.example.com" });
    const res = await TEST(new Request("https://app.test/x", { method: "POST", headers: { "x-user-uid": "admin1" } }), ctx());
    expect(await text(res)).toEqual({ ok: true, reason: null });
    expect(fetchMock.mock.calls[0][0]).toBe("https://geo.example.com/api/v1/scans?limit=1");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("no stored key → ok:false with a reason, no fetch", async () => {
    expect(await text(await TEST(req("POST", {}), ctx()))).toEqual({ ok: false, reason: "No ApexGEO key is saved." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a stored key with a stored non-https base URL is treated as no key", async () => {
    mem.seed(SECRET, { apiKey: KEY, baseUrl: "http://10.0.0.1" });
    expect((await text(await TEST(req("POST", {}), ctx()))).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [RESPONSES.unauthorized, /refused this key/],
    [{ status: 403, body: { error: { code: "forbidden", message: "Insufficient scope" } } }, /read and write scopes/],
    [RESPONSES.serverError, /unexpected response/],
  ])("a failed check gives our reason, never the provider's text", async (r, reason) => {
    fetchMock.mockResolvedValue(reply(r));
    const out = await text(await TEST(req("POST", { apiKey: KEY }), ctx()));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(reason);
    expect(JSON.stringify(out)).not.toContain("Missing or invalid credentials");
  });
});

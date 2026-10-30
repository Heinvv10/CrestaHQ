import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Save a live site as a gitpage template, or stop it being one. The agency
 * owner may save for every client or for this one; a sub-account admin only
 * for this sub-account, and never touches an agency template; a member not
 * at all. Behind the website gate (not upstream). Real route + real tenancy
 * check + real gitpage client over the in-memory Firestore; only the
 * outbound fetch is stubbed.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_admin: { status: "active", agencyId: "ag1" },
  u_member: { status: "active", agencyId: "ag1" },
  u_owner: { status: "active", agencyId: "ag1", agencyRole: "owner" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
}));

const { POST, DELETE } = await import("./route");

const PAGE = "64b7f0c2a1d3e4f5a6b7c8d9";
const SITE = "subAccounts/sa1/website/site1";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
/** gitpage's template list, and what its save answers. */
let list: { clientTemplates: boolean; templates: Array<Record<string, unknown>> };
let savedScope: "agency" | "client";

function call(method: "POST" | "DELETE", opts: { uid?: string; siteId?: string; subAccountId?: string; body?: unknown } = {}): Promise<Response> {
  const uid = opts.uid ?? "u_admin";
  const subAccountId = opts.subAccountId ?? "sa1";
  const req = new Request(`https://app.test/api/sub-accounts/${subAccountId}/website/x/template`, {
    method,
    headers: { "content-type": "application/json", "x-user-uid": uid },
    ...(method === "POST" ? { body: JSON.stringify(opts.body ?? { name: "Gym template" }) } : {}),
  });
  const ctx = { params: Promise.resolve({ id: subAccountId, siteId: opts.siteId ?? "site1" }) };
  return (method === "POST" ? POST(req, ctx) : DELETE(req, ctx)) as Promise<Response>;
}
const gitpageCalls = (method: string) =>
  fetchMock.mock.calls
    .filter(([, init]) => (init?.method ?? "GET") === method)
    .map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }));

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
  mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "ready", gitpagePageId: PAGE, liveUrl: "https://a.gitlab.io/" });
  list = { clientTemplates: true, templates: [] };
  savedScope = "client";
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: { method?: string }) => {
    if ((init?.method ?? "GET") === "GET") return Response.json(list);
    if (init?.method === "POST") return Response.json({ template: { templateId: PAGE, name: "Gym template", scope: savedScope } });
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("who may save or remove a template", () => {
  it("a member is refused before gitpage is asked", async () => {
    expect((await call("POST", { uid: "u_member" })).status).toBe(403);
    expect((await call("DELETE", { uid: "u_member" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["POST"], ["DELETE"]] as const)("%s is refused with the gate off", async (method) => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    const res = await call(method);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining("website builder is disabled") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a site id that is not a doc id is 404 before any read", async () => {
    const doc = vi.spyOn(mem.db, "doc");
    for (const siteId of ["a/b", "..", "site1/private/x"]) {
      expect((await call("POST", { siteId })).status).toBe(404);
    }
    expect(doc).not.toHaveBeenCalled();
    doc.mockRestore();
  });

  it("a site of another sub-account (stamped or by path) is 404", async () => {
    mem.seed("subAccounts/sa1/website/stray", { id: "stray", subAccountId: "sa2", status: "ready", gitpagePageId: PAGE });
    expect((await call("POST", { siteId: "stray" })).status).toBe(404);
    expect((await call("POST", { siteId: "nope" })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("client scope (a sub-account admin)", () => {
  it("saves acting as this client, whatever scope the body asks for", async () => {
    const res = await call("POST", { body: { name: "Gym template", scope: "agency" } });
    expect(res.status).toBe(200);
    expect(gitpageCalls("POST")).toEqual([
      { url: "https://gitpage.test/api/v1/templates", body: { pageId: PAGE, name: "Gym template", actingAs: "client", subAccountId: "sa1" } },
    ]);
  });

  it("cannot rename or remove an agency template", async () => {
    list.templates = [{ templateId: PAGE, name: "Agency one", scope: "agency" }];
    expect((await call("POST")).status).toBe(403);
    expect((await call("DELETE")).status).toBe(403);
    expect(gitpageCalls("POST")).toEqual([]);
    expect(gitpageCalls("DELETE")).toEqual([]);
  });

  it("removes only this client's own template", async () => {
    list.templates = [{ templateId: PAGE, name: "Mine", scope: "client" }];
    expect((await call("DELETE")).status).toBe(200);
    expect(gitpageCalls("DELETE")).toEqual([
      { url: "https://gitpage.test/api/v1/templates", body: { pageId: PAGE, actingAs: "client", subAccountId: "sa1" } },
    ]);
  });

  it("is refused (409) by a gitpage that does not know client templates", async () => {
    list.clientTemplates = false;
    expect((await call("POST")).status).toBe(409);
    expect(gitpageCalls("POST")).toEqual([]);
  });

  it("a save that comes back agency-wide is undone acting as this client (never as the agency) when it was new, and answered 409", async () => {
    savedScope = "agency";
    expect((await call("POST")).status).toBe(409);
    expect(gitpageCalls("DELETE")).toEqual([
      { url: "https://gitpage.test/api/v1/templates", body: { pageId: PAGE, actingAs: "client", subAccountId: "sa1" } },
    ]);
  });

  it("a save answered without a readable template is a 502 and nothing is undone", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      (init?.method ?? "GET") === "GET" ? Response.json(list) : Response.json({ template: null }),
    );
    expect((await call("POST")).status).toBe(502);
    expect(gitpageCalls("DELETE")).toEqual([]);
  });

  it("is 404 when templates are not switched on for the agency's gitpage", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "Not found" }, { status: 404 }));
    expect((await call("POST")).status).toBe(404);
    expect((await call("DELETE")).status).toBe(404);
    expect(gitpageCalls("POST")).toEqual([]);
    expect(gitpageCalls("DELETE")).toEqual([]);
  });

  it("…but a rename of an existing template is not removed on that answer", async () => {
    list.templates = [{ templateId: PAGE, name: "Mine", scope: "client" }];
    savedScope = "agency";
    expect((await call("POST")).status).toBe(409);
    expect(gitpageCalls("DELETE")).toEqual([]);
  });
});

describe("agency scope (the agency owner)", () => {
  it("passes the scope through without checking client templates", async () => {
    savedScope = "agency";
    expect((await call("POST", { uid: "u_owner", body: { name: "Gym template", scope: "agency" } })).status).toBe(200);
    expect(gitpageCalls("GET")).toEqual([]);
    expect(gitpageCalls("POST")[0].body).toEqual({ pageId: PAGE, name: "Gym template", scope: "agency" });
  });

  it("scope \"client\" goes through the client-template check and a wrong answer is undone as this client", async () => {
    savedScope = "agency";
    expect((await call("POST", { uid: "u_owner", body: { name: "Gym template", scope: "client" } })).status).toBe(409);
    expect(gitpageCalls("GET")).toHaveLength(1);
    expect(gitpageCalls("POST")[0].body).toEqual({ pageId: PAGE, name: "Gym template", scope: "client" });
    expect(gitpageCalls("DELETE")[0].body).toEqual({ pageId: PAGE, actingAs: "client", subAccountId: "sa1" });
  });

  it("removes an agency template", async () => {
    expect((await call("DELETE", { uid: "u_owner" })).status).toBe(200);
    expect(gitpageCalls("DELETE")[0].body).toEqual({ pageId: PAGE });
  });
});

describe("requests refused before gitpage", () => {
  it("a site that is not published, or has no gitpage page, is 400", async () => {
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "building", gitpagePageId: PAGE });
    expect((await call("POST")).status).toBe(400);
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "ready", gitpagePageId: null });
    expect((await call("DELETE")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an empty name and one over 60 characters are 400", async () => {
    expect((await call("POST", { body: { name: "   " } })).status).toBe(400);
    expect((await call("POST", { body: { name: "x".repeat(61) } })).status).toBe(400);
    expect((await call("POST", { body: { name: "x".repeat(60) } })).status).toBe(200);
  });

  it("is 503 without a gitpage key", async () => {
    delete process.env.GITPAGE_API_KEY;
    expect((await call("POST")).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("gitpage errors", () => {
  it("reach the browser as the message only, cleaned", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "Site is not\non GitLab", secret: "gp_internal" }, { status: 400 }));
    const res = await call("POST", { uid: "u_owner" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Site is not on GitLab" });
  });

  it("a rejected agency key (401 / 403) is our 502, and a 401 flags the key", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockImplementation(async () => Response.json({ error: "Invalid API key" }, { status }));
      expect((await call("POST", { uid: "u_owner" })).status).toBe(502);
    }
    expect(mem.read("system/gitpageStatus")).toMatchObject({ agency: false, lastError: "401_invalid_api_key" });
  });

  it("anything that is not a gitpage answer is fixed text", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443 key=gp_test_key");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("POST", { uid: "u_owner" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not save the template." });
  });
});

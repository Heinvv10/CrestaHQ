import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * GET the agency's gitpage templates for the wizard's picker and the site
 * cards. Admin-only and behind the website gate (not upstream); the agency's
 * gitpage key never reaches the browser. Real route + real tenancy check +
 * real gitpage client; only the outbound fetch is stubbed.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_admin: { status: "active", agencyId: "ag1" },
  u_member: { status: "active", agencyId: "ag1" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
}));

const { GET } = await import("./route");

const PAGE = "64b7f0c2a1d3e4f5a6b7c8d9";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };

const get = (uid = "u_admin", subAccountId = "sa1") =>
  GET(new Request(`https://app.test/api/sub-accounts/${subAccountId}/website/templates`, { headers: { "x-user-uid": uid } }), {
    params: Promise.resolve({ id: subAccountId }),
  });

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
  fetchMock.mockReset().mockImplementation(async () =>
    Response.json({ clientTemplates: true, templates: [{ templateId: PAGE, name: "Gym", scope: "agency" }, { templateId: "bad", name: "Bad" }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("GET /api/sub-accounts/[id]/website/templates", () => {
  it("lists this sub-account's templates (validated ids only) to an admin, never the key", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("gp_test_key");
    expect(JSON.parse(text)).toEqual({ enabled: true, clientTemplates: true, templates: [expect.objectContaining({ templateId: PAGE, name: "Gym" })] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gitpage.test/api/v1/templates?subAccountId=sa1");
  });

  it("refuses a member before gitpage is asked", async () => {
    expect((await get("u_member")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses with the builder's 403 when the gate is off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining("website builder is disabled") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a path-shaped sub-account id is 404 before any read", async () => {
    const doc = vi.spyOn(mem.db, "doc");
    expect((await get("u_admin", "sa1/website/x")).status).toBe(404);
    expect(doc).not.toHaveBeenCalled();
    doc.mockRestore();
  });
});

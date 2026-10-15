import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * POST sync: the Websites page imports the client's gitpage copies when it
 * opens. Admin-only and behind the website gate (not upstream); a failure
 * is quiet ({ ok: false }, 200). Real route + real import service + real
 * gitpage client over the in-memory Firestore; only the outbound fetch is
 * stubbed.
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

const { POST } = await import("./route");

const PAGE = "64b7f0c2a1d3e4f5a6b7c8d9";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };

const sync = (uid = "u_admin", subAccountId = "sa1") =>
  POST(new Request(`https://app.test/api/sub-accounts/${subAccountId}/website/sync`, { method: "POST", headers: { "x-user-uid": uid } }), {
    params: Promise.resolve({ id: subAccountId }),
  });

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: { method?: string }) =>
    init?.method === "POST"
      ? Response.json({ ok: true })
      : Response.json({ sites: [{ pageId: PAGE, status: "Published", liveUrl: "https://copy.gitlab.io/", origin: "duplicate" }] }),
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

describe("POST /api/sub-accounts/[id]/website/sync", () => {
  it("imports the client's copy for an admin", async () => {
    const res = await sync();
    expect(await res.json()).toEqual({ ok: true, imported: 1 });
    expect(mem.read(`subAccounts/sa1/website/gp-${PAGE}`)).toMatchObject({ importedFrom: "gitpage", subAccountId: "sa1" });
  });

  it("refuses a member and the gate-off workspace before gitpage is asked", async () => {
    expect((await sync("u_member")).status).toBe(403);
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    expect((await sync()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.list("subAccounts/sa1/website")).toEqual([]);
  });

  it("a path-shaped sub-account id is 404 before any read", async () => {
    const doc = vi.spyOn(mem.db, "doc");
    expect((await sync("u_admin", "sa1/website/x")).status).toBe(404);
    expect(doc).not.toHaveBeenCalled();
    doc.mockRestore();
  });

  it("a gitpage failure is quiet, and logs the message only", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "down" }, { status: 503 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sync();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, imported: 0 });
    expect(errors.mock.calls.every((args) => args.every((a) => typeof a === "string"))).toBe(true);
    errors.mockRestore();
  });
});

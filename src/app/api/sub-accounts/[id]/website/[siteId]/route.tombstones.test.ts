import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Remove a website: its gitpage sites are tombstoned (`websiteDismissed`) in
 * the same transaction as the delete, so a sync never brings them back —
 * the doc goes and the tombstones stay, or neither (not upstream, which
 * wrote them separately and swallowed failures). Once that has committed
 * the sites are hidden in gitpage, after the response and best-effort. Real
 * route + real tenancy check + real gitpage client over the in-memory
 * Firestore; only the outbound fetch is stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1" } }) }),
}));

const { DELETE } = await import("./route");

const SITE_ID = "gp-64b7f0c2a1d3e4f5a6b7c8d1";
const SITE = `subAccounts/sa1/website/${SITE_ID}`;
const CURRENT = "64b7f0c2a1d3e4f5a6b7c8d2";
const REPLACED = "64b7f0c2a1d3e4f5a6b7c8d3";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };

const remove = (siteId = SITE_ID) =>
  DELETE(new Request(`https://app.test/api/sub-accounts/sa1/website/${siteId}`, { method: "DELETE", headers: { "x-user-uid": "u_admin" } }), {
    params: Promise.resolve({ id: "sa1", siteId }),
  });
const tombstones = () => mem.list("subAccounts/sa1/websiteDismissed").map((d) => d.id).sort();
const hidden = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body) as { pageId: string }).map((b) => b.pageId).sort();

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
  mem.seed(SITE, { id: SITE_ID, agencyId: "ag1", subAccountId: "sa1", status: "ready", gitpagePageId: CURRENT, replacesGitpagePageId: REPLACED });
  fetchMock.mockReset().mockImplementation(async () => Response.json({ ok: true }));
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

describe("DELETE /api/sub-accounts/[id]/website/[siteId] — tombstones and hide", () => {
  const ALL = [CURRENT, REPLACED, SITE_ID.slice(3)].sort();

  it("tombstones every gitpage site of the doc in the delete's transaction, then hides them after the response", async () => {
    let tombsAtCommit: string[] | null = null;
    const runTransaction = mem.db.runTransaction;
    vi.spyOn(mem.db, "runTransaction").mockImplementation(async (fn) => {
      const out = await runTransaction(fn);
      tombsAtCommit = tombstones();
      // The commit removed the doc and wrote the tombstones together; nothing hidden yet.
      expect(mem.read(SITE)).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      return out;
    });
    expect((await remove()).status).toBe(200);
    expect(tombsAtCommit).toEqual(ALL);
    await flushAfterResponse();
    expect(hidden()).toEqual(ALL);
    expect(fetchMock.mock.calls.every(([url]) => url === "https://gitpage.test/api/v1/sites")).toBe(true);
  });

  it("a transaction that fails leaves the doc and writes no tombstone", async () => {
    const runTransaction = mem.db.runTransaction;
    vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) =>
      // The body runs for real against a real transaction, and then the commit fails.
      runTransaction(async (tx) => {
        await fn(tx);
        throw Object.assign(new Error("10 ABORTED: contention"), { code: 10 });
      }),
    );
    await expect(remove()).rejects.toThrow("ABORTED");
    await flushAfterResponse();
    expect(mem.read(SITE)).toBeDefined();
    expect(tombstones()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a gitpage failure hiding a site does not fail the delete, nor stop the other sites being hidden", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "nope" }, { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await remove()).status).toBe(200);
    await flushAfterResponse();
    expect(hidden()).toEqual(ALL);
    expect(mem.read(SITE)).toBeUndefined();
    expect(tombstones()).toEqual(ALL);
  });

  it("a doc stamped with another sub-account gets no tombstones and nothing is hidden", async () => {
    mem.seed(SITE, { id: SITE_ID, agencyId: "ag1", subAccountId: "sa2", status: "ready", gitpagePageId: CURRENT });
    await remove();
    await flushAfterResponse();
    expect(tombstones()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only gitpage ObjectIds become tombstones", async () => {
    mem.seed("subAccounts/sa1/website/site1", { id: "site1", subAccountId: "sa1", status: "ready", gitpagePageId: "page_42", replacesGitpagePageId: REPLACED });
    await remove("site1");
    await flushAfterResponse();
    expect(tombstones()).toEqual([REPLACED]);
    expect(hidden()).toEqual([REPLACED]);
  });
});

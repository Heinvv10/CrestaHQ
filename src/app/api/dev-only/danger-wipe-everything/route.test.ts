import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dev-only wipe route. NODE_ENV guards production; these cover `pnpm dev`
 * pointed at real keys, where a cross-site page (no session, or a logged-in
 * owner's browser) must not be able to trigger it.
 */

const claims = new Map<string, Record<string, unknown>>();
const listCollections = vi.fn(async () => []);
const listUsers = vi.fn(async () => ({ users: [], pageToken: undefined }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ listCollections, recursiveDelete: vi.fn() }),
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: claims.get(uid) ?? {} }),
    listUsers,
    deleteUsers: vi.fn(),
  }),
}));

const { POST } = await import("./route");

const URL_ = "http://localhost:3000/api/dev-only/danger-wipe-everything?confirm=NUKE";
function post(headers: Record<string, string>) {
  return POST(new Request(URL_, { method: "POST", headers }));
}

beforeEach(() => {
  vi.clearAllMocks();
  claims.clear();
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  claims.set("member", { status: "active", role: "member", agencyId: "ag1" });
});

describe("POST /api/dev-only/danger-wipe-everything", () => {
  it("refuses a caller with no session", async () => {
    const res = await post({ origin: "http://localhost:3000" });
    expect(res.status).toBe(401);
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-owner", async () => {
    const res = await post({ origin: "http://localhost:3000", "x-user-uid": "member" });
    expect(res.status).toBe(403);
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("refuses a cross-site POST even from the owner's browser", async () => {
    const res = await post({ origin: "https://evil.example", "x-user-uid": "owner" });
    expect(res.status).toBe(403);
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("refuses a POST with no Origin at all", async () => {
    const res = await post({ "x-user-uid": "owner" });
    expect(res.status).toBe(403);
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("runs for the agency owner on a same-origin POST", async () => {
    const res = await post({ origin: "http://localhost:3000", "x-user-uid": "owner" });
    expect(res.status).toBe(200);
    expect(listCollections).toHaveBeenCalledTimes(1);
  });
});

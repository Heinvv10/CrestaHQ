import { beforeEach, expect, it, vi } from "vitest";

/**
 * Regression for the middleware fix in withoutIdentityHeaders(): this route
 * is reachable without a session (`/api/forms` is a middleware PUBLIC_PATH,
 * for the unauthenticated submit endpoint), and DELETE trusts
 * `x-user-uid` via `requireSubAccountMember` to authorize the delete —
 * NOT mocked here, so the real `readUidFromHeaders` runs. Before the
 * middleware fix, a session-less caller could forge that header straight
 * through to this route and delete another member's forms + submissions.
 *
 * The middleware-level proof that a forged header actually gets stripped
 * lives in src/middleware.test.ts ("middleware() end to end"); this test
 * proves the other half of the chain — given the POST-strip state (no
 * x-user-uid at all), the route itself refuses rather than silently
 * treating the caller as authenticated.
 */

const docs = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (p: string) => ({
      get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
    }),
    recursiveDelete: async () => {},
  }),
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({
      customClaims: uid === "real-member-uid" ? { status: "active", agencyId: "ag1", agencyRole: "owner" } : {},
    }),
  }),
}));

import { DELETE } from "./route";

const del = (headers: Record<string, string> = {}) =>
  DELETE(new Request("https://example.com/api/forms/f1", { method: "DELETE", headers }), {
    params: Promise.resolve({ id: "f1" }),
  });

beforeEach(() => {
  docs.clear();
  docs.set("forms/f1", { subAccountId: "sa1" });
  docs.set("subAccounts/sa1", { agencyId: "ag1" });
});

it("refuses with 401 when the caller has no identity header — the state AFTER middleware strips a forged x-user-uid", async () => {
  const res = await del();
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("Not authenticated");
});

it("the header IS load-bearing when present — a real member's uid succeeds (proves the 401 above isn't vacuous)", async () => {
  const res = await del({ "x-user-uid": "real-member-uid" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/sub-accounts/[id]/members/[uid] writes one `member.role_changed`
 * audit event when the role actually changes. Real route, real tenancy,
 * in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { claims, mem, storeDb } from "@/test/gbp-sync-store";
import { PATCH } from "./route";

const SA = "sa_1";

async function patch(body: Record<string, unknown>, uid = "uid_admin", target = "uid_m") {
  const res = await PATCH(
    new Request(`http://127.0.0.1:3100/api/sub-accounts/${SA}/members/${target}`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA, uid: target }) },
  );
  return res.status;
}

const events = () => mem.list("auditEvents");
const member = (role: string) => ({ uid: "x", status: "active", role });

beforeEach(() => {
  mem.clear();
  claims.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_admin`, member("admin"));
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_collab`, member("collaborator"));
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_m`, member("collaborator"));
  mem.seed(`userMemberships/uid_m/subAccounts/${SA}`, { role: "collaborator" });
  mem.seed(`subAccounts/${SA}/territories/t1`, { status: "active" });
  // The admin's claims name a different agency: the event's agencyId must
  // come from the sub-account doc, not from anything the caller carries.
  claims.set("uid_admin", { status: "active", agencyId: "ag_claims", agencyRole: null });
  claims.set("uid_collab", { status: "active", agencyId: "ag_1", agencyRole: null });
});
afterEach(() => vi.restoreAllMocks());

describe("member role PATCH audit", () => {
  it("records the role change, tenant from the sub-account doc, actor from the session", async () => {
    expect(
      await patch({
        role: "admin",
        agencyId: "ag_evil",
        subAccountId: "sa_evil",
        actor: { type: "user", id: "uid_evil" },
        uid: "uid_evil",
      }),
    ).toBe(200);
    expect(mem.read(`subAccounts/${SA}/subAccountMembers/uid_m`)?.role).toBe("admin");

    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "member.role_changed",
      actor: { type: "user", id: "uid_admin" },
      target: { type: "member", id: "uid_m" },
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "uid_admin",
      changes: [{ field: "role", before: "collaborator", after: "admin" }],
    });
  });

  it("records nothing when the role is unchanged or only territories changed", async () => {
    expect(await patch({ role: "collaborator" })).toBe(200);
    expect(await patch({ assignedTerritoryIds: ["t1"] })).toBe(200);
    expect(events()).toHaveLength(0);
  });

  it("records nothing for a refused caller", async () => {
    expect(await patch({ role: "admin" }, "uid_collab")).toBe(403);
    expect(events()).toHaveLength(0);
  });

  it("a failed audit write does not fail the request", async () => {
    const real = storeDb.collection;
    vi.spyOn(storeDb, "collection").mockImplementation((path: string) =>
      path === "auditEvents"
        ? ({ add: async () => { throw new Error("14 UNAVAILABLE"); } } as unknown as ReturnType<typeof real>)
        : real(path),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await patch({ role: "admin" })).toBe(200);
    expect(mem.read(`subAccounts/${SA}/subAccountMembers/uid_m`)?.role).toBe("admin");
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "[audit] failed to record member.role_changed",
    );
  });

  it("records nothing when the change itself fails to commit", async () => {
    const realBatch = storeDb.batch;
    vi.spyOn(storeDb, "batch").mockImplementation(() => ({
      ...realBatch(),
      commit: async () => { throw new Error("10 ABORTED"); },
    }) as unknown as ReturnType<typeof realBatch>);
    await expect(patch({ role: "admin" })).rejects.toThrow("ABORTED");
    expect(mem.read(`subAccounts/${SA}/subAccountMembers/uid_m`)?.role).toBe("collaborator");
    expect(events()).toHaveLength(0);
  });
});

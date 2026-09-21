import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/sub-accounts/[id]/workflows/[workflowId] writes one
 * `workflow.status_changed` audit event when the status actually changes.
 * Real route, real tenancy, real update service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { claims, mem, storeDb } from "@/test/gbp-sync-store";
import { PATCH } from "./route";

const SA = "sa_1";

async function patch(body: Record<string, unknown>, uid = "uid_collab", workflowId = "wf1") {
  const res = await PATCH(
    new Request(`http://127.0.0.1:3100/api/sub-accounts/${SA}/workflows/${workflowId}`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA, workflowId }) },
  );
  return res.status;
}

const events = () => mem.list("auditEvents");

beforeEach(() => {
  mem.clear();
  claims.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_collab`, { status: "active", role: "collaborator" });
  mem.seed("workflows/wf1", { subAccountId: SA, agencyId: "ag_1", name: "Review ask", status: "draft", nodes: {} });
  mem.seed("workflows/wf_other", { subAccountId: "sa_2", agencyId: "ag_1", name: "Theirs", status: "draft", nodes: {} });
  // Claims name a different agency: the event's agencyId must come from the
  // sub-account doc, not from anything the caller carries.
  claims.set("uid_collab", { status: "active", agencyId: "ag_claims", agencyRole: null });
  claims.set("uid_out", { status: "active", agencyId: "ag_1", agencyRole: null });
});
afterEach(() => vi.restoreAllMocks());

describe("workflow status PATCH audit", () => {
  it("records the status change, tenant from the sub-account doc, actor from the session", async () => {
    expect(
      await patch({
        status: "active",
        agencyId: "ag_evil",
        subAccountId: "sa_evil",
        actor: { type: "user", id: "uid_evil" },
      }),
    ).toBe(200);
    expect(mem.read("workflows/wf1")?.status).toBe("active");

    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "workflow.status_changed",
      actor: { type: "user", id: "uid_collab" },
      target: { type: "workflow", id: "wf1" },
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "uid_collab",
      changes: [{ field: "status", before: "draft", after: "active" }],
    });
  });

  it("records each transition: active -> paused", async () => {
    await patch({ status: "active" });
    await patch({ status: "paused" });
    expect(events().map((e) => (e.changes as unknown[])[0])).toEqual(
      expect.arrayContaining([{ field: "status", before: "active", after: "paused" }]),
    );
    expect(events()).toHaveLength(2);
  });

  it("records nothing when the status is unchanged or only the name changed", async () => {
    expect(await patch({ status: "draft" })).toBe(200);
    expect(await patch({ name: "Renamed" })).toBe(200);
    expect(await patch({ status: "archived" })).toBe(200); // not a status: ignored
    expect(events()).toHaveLength(0);
  });

  it("records nothing for another sub-account's workflow or a non-member", async () => {
    expect(await patch({ status: "active" }, "uid_collab", "wf_other")).toBe(404);
    expect(await patch({ status: "active" }, "uid_out")).toBe(403);
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
    expect(await patch({ status: "active" })).toBe(200);
    expect(mem.read("workflows/wf1")?.status).toBe("active");
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "[audit] failed to record workflow.status_changed",
    );
  });

  it("an event that cannot be built (sub-account doc has no agencyId) is logged, not thrown", async () => {
    mem.seed(`subAccounts/${SA}`, { name: "no agency" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await patch({ status: "active" })).toBe(200);
    expect(mem.read("workflows/wf1")?.status).toBe("active");
    expect(events()).toHaveLength(0);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "[audit] could not record workflow.status_changed on workflow/wf1",
    );
  });
});

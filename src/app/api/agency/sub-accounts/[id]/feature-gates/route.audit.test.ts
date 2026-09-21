import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates writes one
 * `feature_gates.updated` audit event for the gates it actually changed.
 * Real route, real tenancy, real gate service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { claims, mem, storeDb } from "@/test/gbp-sync-store";
import { PATCH } from "./route";

const SA = "sa_1";

async function patch(body: Record<string, unknown>, uid = "uid_owner") {
  const res = await PATCH(
    new Request(`http://127.0.0.1:3100/api/agency/sub-accounts/${SA}/feature-gates`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
  return res.status;
}

const events = () => mem.list("auditEvents");

beforeEach(() => {
  mem.clear();
  claims.clear();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag_1",
    googleEnabledByAgency: true,
    whatsappEnabledByAgency: false,
  });
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
  claims.set("uid_admin", { status: "active", agencyId: "ag_1", agencyRole: null });
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_admin`, { status: "active", role: "admin" });
});
afterEach(() => vi.restoreAllMocks());

describe("feature-gate PATCH audit", () => {
  it("records the changed gates, tenant from the sub-account doc, actor from the session", async () => {
    expect(
      await patch({
        googleEnabled: false,
        whatsappEnabled: false, // already off: not a change
        // Forged tenant and actor fields in the body are ignored.
        agencyId: "ag_evil",
        subAccountId: "sa_evil",
        actor: { type: "user", id: "uid_evil" },
        createdByUid: "uid_evil",
      }),
    ).toBe(200);
    expect(mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency).toBe(false);

    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "feature_gates.updated",
      actor: { type: "user", id: "uid_owner" },
      target: { type: "subAccount", id: SA },
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "uid_owner",
      changes: [{ field: "googleEnabledByAgency", before: true, after: false }],
    });
  });

  it("records nothing when no gate changed, or only a non-gate field did", async () => {
    expect(await patch({ googleEnabled: true, whatsappEnabled: false })).toBe(200);
    expect(await patch({ websiteHiddenWhenDisabled: true })).toBe(200);
    expect(events()).toHaveLength(0);
  });

  it("records nothing for a refused caller", async () => {
    expect(await patch({ googleEnabled: false }, "uid_admin")).toBe(403);
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
    expect(await patch({ googleEnabled: false })).toBe(200);
    expect(mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "[audit] failed to record feature_gates.updated",
    );
  });

  it("diffs against the effective value: an unset opt-OUT gate is already on", async () => {
    // smsAgentEnabledByAgency is unset (reads as ON); whatsapp is set false.
    mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1" });
    expect(await patch({ smsAgentEnabled: true, whatsappEnabled: false })).toBe(200);
    expect(events()).toHaveLength(0);

    expect(await patch({ webChatEnabled: false, whatsappEnabled: true })).toBe(200);
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0].changes).toEqual([
      { field: "whatsappEnabledByAgency", before: false, after: true },
      { field: "webChatEnabledByAgency", before: true, after: false },
    ]);
  });
});


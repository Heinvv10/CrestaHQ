import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the Agent API gate
 * (`agentApiEnabled` → `agentApiEnabledByAgency`, Agent API v1 PR1). Opt-in,
 * plan-managed, no tear-down: an `agent`-scope key mint is simply refused
 * while off; existing keys are preserved. Real tenancy, real gate service,
 * in-memory Firestore.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof createMemoryFirestore> | null }));
const claims: Record<string, Record<string, unknown>> = {
  uid_owner: { status: "active", agencyId: "ag_1", agencyRole: "owner" },
  uid_admin: { status: "active", agencyId: "ag_1", agencyRole: null },
};
vi.mock("@/lib/firebase/admin", async () => {
  const { createMemoryFirestore: make } = await import("@/test/memory-firestore");
  mem.ref = make();
  return {
    getAdminDb: () => mem.ref!.db,
    getAdminAuth: () => ({
      getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }),
    }),
  };
});

import { PATCH } from "./route";

const SA = "sa_1";

async function patch(body: Record<string, unknown>, uid = "uid_owner") {
  return PATCH(
    new Request(`http://127.0.0.1:3100/api/agency/sub-accounts/${SA}/feature-gates`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
}

const db = () => mem.ref!;
const gate = () => db().read(`subAccounts/${SA}`)?.agentApiEnabledByAgency;
const auditRows = () =>
  db()
    .list("auditEvents")
    .filter((r) => r.action === "feature_gates.updated" && (r.target as { id?: string })?.id === SA);

beforeEach(() => {
  db().clear();
  db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture" });
  db().seed(`subAccounts/${SA}/subAccountMembers/uid_admin`, { status: "active", role: "admin" });
  db().seed("agencies/ag_1/agencyMembers/uid_owner", { role: "owner", status: "active" });
});

// PR #346 fix-review REPRO 2: the owner claim outlives a removal, so switching
// a reach gate ON re-reads the caller's agencyMembers row.
describe.each([
  ["agentApiEnabled", "agentApiEnabledByAgency"],
  ["apiAccessEnabled", "apiAccessEnabledByAgency"],
])("%s with the owner's agencyMembers row removed", (field, stored) => {
  beforeEach(() => {
    db().seed("agencies/ag_1/agencyMembers/uid_owner", { role: "owner", status: "removed" });
  });

  it("refuses switching it on and writes nothing", async () => {
    expect((await patch({ [field]: true })).status).toBe(403);
    expect(db().read(`subAccounts/${SA}`)?.[stored]).toBeUndefined();
  });

  it("still allows switching it off", async () => {
    expect((await patch({ [field]: false })).status).toBe(200);
    expect(db().read(`subAccounts/${SA}`)?.[stored]).toBe(false);
  });
});

describe("agentApiEnabled", () => {
  it("only the agency owner may change it", async () => {
    const res = await patch({ agentApiEnabled: true }, "uid_admin");
    expect(res.status).toBe(403);
    expect(gate()).toBeUndefined();
  });

  it("writes the gate both ways", async () => {
    expect((await patch({ agentApiEnabled: true })).status).toBe(200);
    expect(gate()).toBe(true);
    expect((await patch({ agentApiEnabled: false })).status).toBe(200);
    expect(gate()).toBe(false);
  });

  it("records an audit row for the change", async () => {
    expect(auditRows()).toHaveLength(0);
    expect((await patch({ agentApiEnabled: true })).status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "feature_gates.updated",
      actor: { type: "user", id: "uid_owner" },
      target: { type: "subAccount", id: SA },
      changes: [{ field: "agentApiEnabledByAgency", before: false, after: true }],
    });
  });

  it("does not record an audit row when the value doesn't change", async () => {
    // Field is legacy-undefined → effective value is already false.
    expect((await patch({ agentApiEnabled: false })).status).toBe(200);
    expect(auditRows()).toHaveLength(0);
  });
});

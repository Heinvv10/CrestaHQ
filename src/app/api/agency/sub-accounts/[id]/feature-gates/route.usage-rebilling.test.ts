import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — a client's usage
 * rebilling switch (`usageRebillingEnabled`). Not a gate: agency owner
 * only, refused ON unless the agency master switch is on (and before any
 * other field in the body is written), re-checks the live owner row on
 * enable, stamps `usageRebillingSince` on off→on, audited.
 * Real route, real tenancy, in-memory Firestore.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof createMemoryFirestore> | null }));
const claims: Record<string, Record<string, unknown>> = {
  uid_owner: { status: "active", agencyId: "ag_1", agencyRole: "owner" },
  uid_admin: { status: "active", agencyId: "ag_1", agencyRole: null },
  uid_other_owner: { status: "active", agencyId: "ag_2", agencyRole: "owner" },
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
const sub = () => db().read(`subAccounts/${SA}`)!;
const auditRows = () => db().list("auditEvents").filter((r) => r.action === "usage_rebilling.updated");

function agencySwitch(on: boolean) {
  db().seed("agencies/ag_1", { name: "Agency", usageRebillingEnabled: on });
}

beforeEach(() => {
  db().clear();
  db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture" });
  db().seed(`subAccounts/${SA}/subAccountMembers/uid_admin`, { status: "active", role: "admin" });
  db().seed("agencies/ag_1/agencyMembers/uid_owner", { role: "owner", status: "active" });
  agencySwitch(true);
});

describe("usageRebillingEnabled", () => {
  it("a sub-account admin cannot set it (403), nothing written", async () => {
    const res = await patch({ usageRebillingEnabled: true }, "uid_admin");
    expect(res.status).toBe(403);
    expect(sub().usageRebillingEnabled).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it("a sub-account admin cannot switch it off either (403)", async () => {
    db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture", usageRebillingEnabled: true });
    expect((await patch({ usageRebillingEnabled: false }, "uid_admin")).status).toBe(403);
    expect(sub().usageRebillingEnabled).toBe(true);
    expect(auditRows()).toHaveLength(0);
  });

  it("an owner whose agencyMembers row was removed cannot switch it on (403)", async () => {
    db().seed("agencies/ag_1/agencyMembers/uid_owner", { role: "owner", status: "removed" });
    expect((await patch({ usageRebillingEnabled: true })).status).toBe(403);
    expect(sub().usageRebillingEnabled).toBeUndefined();
  });

  it("switching on is refused while the agency switch is off, and nothing else in the body lands", async () => {
    agencySwitch(false);
    const res = await patch({ usageRebillingEnabled: true, agentApiEnabled: true, usageQuotas: { emailsPerMonth: 5 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/agency first/);
    expect(sub().usageRebillingEnabled).toBeUndefined();
    expect(sub().agentApiEnabledByAgency).toBeUndefined();
    expect(sub().usageQuotas).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it("a body that X0's AI-outbound-SMS refusal turns away writes no rebilling either", async () => {
    const res = await patch({ usageRebillingEnabled: true, aiOutboundSmsEnabled: true });
    expect(res.status).toBe(409);
    expect(sub().usageRebillingEnabled).toBeUndefined();
    expect(sub().aiOutboundSmsEnabledByAgency).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it("switching on with the agency switch on writes it, stamps since, and audits", async () => {
    const res = await patch({ usageRebillingEnabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, usageRebillingEnabled: true });
    expect(sub().usageRebillingEnabled).toBe(true);
    expect(sub().usageRebillingSince).toBeDefined();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: { type: "user", id: "uid_owner" },
      target: { type: "subAccount", id: SA },
      agencyId: "ag_1",
      subAccountId: SA,
      changes: [{ field: "usageRebillingEnabled", before: false, after: true }],
    });
  });

  it("switching on again keeps the first since and records no second event", async () => {
    db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture", usageRebillingEnabled: true, usageRebillingSince: "first" });
    expect((await patch({ usageRebillingEnabled: true })).status).toBe(200);
    expect(sub().usageRebillingSince).toBe("first");
    expect(auditRows()).toHaveLength(0);
  });

  it("switching off is always allowed, even with the agency switch off, and audited", async () => {
    db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture", usageRebillingEnabled: true, usageRebillingSince: "first" });
    agencySwitch(false);
    db().seed("agencies/ag_1/agencyMembers/uid_owner", { role: "owner", status: "removed" });
    expect((await patch({ usageRebillingEnabled: false })).status).toBe(200);
    expect(sub().usageRebillingEnabled).toBe(false);
    expect(sub().usageRebillingSince).toBe("first");
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ changes: [{ field: "usageRebillingEnabled", before: true, after: false }] });
  });

  it.each([["a string", "yes"], ["a number", 1], ["null", null], ["an object", { on: true }]])(
    "%s is refused (400) and nothing else in the body lands",
    async (_label, value) => {
      const res = await patch({ usageRebillingEnabled: value, agentApiEnabled: true });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("usageRebillingEnabled must be a boolean.");
      expect(sub().usageRebillingEnabled).toBeUndefined();
      expect(sub().agentApiEnabledByAgency).toBeUndefined();
    }
  );

  it.each([true, false])("another agency's owner cannot set it to %s (403)", async (value) => {
    db().seed("agencies/ag_2/agencyMembers/uid_other_owner", { role: "owner", status: "active" });
    db().seed("agencies/ag_2", { name: "Other", usageRebillingEnabled: true });
    db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture", usageRebillingEnabled: !value });
    const res = await patch({ usageRebillingEnabled: value }, "uid_other_owner");
    expect(res.status).toBe(403);
    expect(sub().usageRebillingEnabled).toBe(!value);
    expect(auditRows()).toHaveLength(0);
  });

  it("the agency switch is read from the sub-account's own agency, not the body", async () => {
    agencySwitch(false);
    db().seed("agencies/ag_2", { name: "Other", usageRebillingEnabled: true });
    expect((await patch({ usageRebillingEnabled: true, agencyId: "ag_2" })).status).toBe(400);
    expect(sub().usageRebillingEnabled).toBeUndefined();
  });
});

describe("concurrent toggles", () => {
  it("two simultaneous switch-ons write one audit row", async () => {
    const [a, b] = await Promise.all([
      patch({ usageRebillingEnabled: true }),
      patch({ usageRebillingEnabled: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sub().usageRebillingEnabled).toBe(true);
    expect(auditRows()).toHaveLength(1);
  });
});

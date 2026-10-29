import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency PATCH `usageRebillingEnabled` — the usage rebilling master switch.
 * Owner only, boolean only, live owner row re-checked on enable,
 * `usageRebillingSince` stamped on off→on, an agency-level audit event per
 * real change. Real route over an in-memory Firestore.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof import("@/test/memory-firestore").createMemoryFirestore> | null }));
const claims: Record<string, Record<string, unknown>> = {
  owner1: { status: "active", agencyId: "ag1", agencyRole: "owner" },
  staff1: { status: "active", agencyId: "ag1", agencyRole: "staff" },
};
vi.mock("@/lib/firebase/admin", async () => {
  const { createMemoryFirestore: make } = await import("@/test/memory-firestore");
  mem.ref = make();
  return {
    getAdminDb: () => mem.ref!.db,
    getAdminAuth: () => ({ getUser: async (uid: string) => (claims[uid] ? { customClaims: claims[uid] } : null) }),
  };
});
vi.mock("@/lib/agency/policy", () => ({ invalidateAgencyPolicyCache: vi.fn() }));

const { PATCH } = await import("./route");
const db = () => mem.ref!;
const agency = () => db().read("agencies/ag1")!;
const auditRows = () => db().list("auditEvents").filter((r) => r.action === "usage_rebilling.updated");

const patch = (uid: string, body: unknown) =>
  PATCH(
    new Request("http://x/api/agency", {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  db().clear();
  db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1" });
  db().seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
});

describe("usageRebillingEnabled (agency master switch)", () => {
  it("a non-owner cannot set it (403)", async () => {
    expect((await patch("staff1", { usageRebillingEnabled: true })).status).toBe(403);
    expect(agency()).not.toHaveProperty("usageRebillingEnabled");
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a non-boolean", async () => {
    expect((await patch("owner1", { usageRebillingEnabled: "on" })).status).toBe(400);
    expect(agency()).not.toHaveProperty("usageRebillingEnabled");
  });

  it("an owner whose agencyMembers row was removed cannot switch it on, but can switch it off", async () => {
    db().seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "removed" });
    expect((await patch("owner1", { usageRebillingEnabled: true })).status).toBe(403);
    expect(agency()).not.toHaveProperty("usageRebillingEnabled");
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usageRebillingEnabled: true });
    expect((await patch("owner1", { usageRebillingEnabled: false })).status).toBe(200);
    expect(agency().usageRebillingEnabled).toBe(false);
  });

  it("the owner switches it on: stored, since stamped, one agency-level audit event", async () => {
    expect((await patch("owner1", { usageRebillingEnabled: true })).status).toBe(200);
    expect(agency().usageRebillingEnabled).toBe(true);
    expect(agency().usageRebillingSince).toBeDefined();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: { type: "user", id: "owner1" },
      target: { type: "agency", id: "ag1" },
      agencyId: "ag1",
      subAccountId: null,
      changes: [{ field: "usageRebillingEnabled", before: false, after: true }],
    });
  });

  it("no change records nothing and keeps the first since", async () => {
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usageRebillingEnabled: true, usageRebillingSince: "first" });
    expect((await patch("owner1", { usageRebillingEnabled: true })).status).toBe(200);
    expect(agency().usageRebillingSince).toBe("first");
    expect(auditRows()).toHaveLength(0);
  });

  it("switching off is audited and leaves since alone", async () => {
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usageRebillingEnabled: true, usageRebillingSince: "first" });
    expect((await patch("owner1", { usageRebillingEnabled: false })).status).toBe(200);
    expect(agency().usageRebillingEnabled).toBe(false);
    expect(agency().usageRebillingSince).toBe("first");
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ changes: [{ field: "usageRebillingEnabled", before: true, after: false }] });
  });
});

describe("switching the master off switches every client of the agency off", () => {
  const clientRows = () => auditRows().filter((r) => (r.target as { type: string }).type === "subAccount");

  beforeEach(() => {
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usageRebillingEnabled: true });
    db().seed("subAccounts/sa1", { agencyId: "ag1", name: "One", usageRebillingEnabled: true });
    db().seed("subAccounts/sa2", { agencyId: "ag1", name: "Two", usageRebillingEnabled: true });
    db().seed("subAccounts/sa3", { agencyId: "ag1", name: "Three", usageRebillingEnabled: false });
    db().seed("subAccounts/sb1", { agencyId: "ag2", name: "Other agency", usageRebillingEnabled: true });
  });

  it("off: every rebilled client of this agency off, one audit row each; others untouched", async () => {
    expect((await patch("owner1", { usageRebillingEnabled: false })).status).toBe(200);
    expect(agency().usageRebillingEnabled).toBe(false);
    expect(db().read("subAccounts/sa1")!.usageRebillingEnabled).toBe(false);
    expect(db().read("subAccounts/sa2")!.usageRebillingEnabled).toBe(false);
    expect(db().read("subAccounts/sa3")!.usageRebillingEnabled).toBe(false);
    expect(db().read("subAccounts/sb1")!.usageRebillingEnabled).toBe(true);
    const rows = clientRows();
    expect(rows.map((r) => (r.target as { id: string }).id).sort()).toEqual(["sa1", "sa2"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        agencyId: "ag1",
        subAccountId: (r.target as { id: string }).id,
        actor: { type: "user", id: "owner1" },
        changes: [{ field: "usageRebillingEnabled", before: true, after: false }],
      });
    }
    expect(auditRows().filter((r) => r.subAccountId === null)).toHaveLength(1);
  });

  it("off then on: the master is on again and no client is reactivated", async () => {
    expect((await patch("owner1", { usageRebillingEnabled: false })).status).toBe(200);
    expect((await patch("owner1", { usageRebillingEnabled: true })).status).toBe(200);
    expect(agency().usageRebillingEnabled).toBe(true);
    expect(db().read("subAccounts/sa1")!.usageRebillingEnabled).toBe(false);
    expect(db().read("subAccounts/sa2")!.usageRebillingEnabled).toBe(false);
    expect(clientRows()).toHaveLength(2);
  });

  it("re-saving the master on leaves every rebilled client on", async () => {
    expect((await patch("owner1", { usageRebillingEnabled: true })).status).toBe(200);
    expect(db().read("subAccounts/sa1")!.usageRebillingEnabled).toBe(true);
    expect(db().read("subAccounts/sa2")!.usageRebillingEnabled).toBe(true);
    expect(clientRows()).toHaveLength(0);
  });

  it("more rebilled clients than one transaction holds are all switched off", async () => {
    const { REBILLING_CASCADE_CHUNK } = await import("@/lib/server/usage-rebilling");
    const n = REBILLING_CASCADE_CHUNK + 3;
    for (let i = 0; i < n; i++) {
      db().seed(`subAccounts/bulk${i}`, { agencyId: "ag1", name: `Bulk ${i}`, usageRebillingEnabled: true });
    }
    expect((await patch("owner1", { usageRebillingEnabled: false })).status).toBe(200);
    const stillOn = db().all().filter((d) => d.path.startsWith("subAccounts/") && d.data.agencyId === "ag1" && d.data.usageRebillingEnabled === true);
    expect(stillOn).toEqual([]);
    expect(clientRows()).toHaveLength(n + 2);
  });
});

describe("concurrent toggles", () => {
  it("two simultaneous switch-ons write one audit row", async () => {
    const [a, b] = await Promise.all([
      patch("owner1", { usageRebillingEnabled: true }),
      patch("owner1", { usageRebillingEnabled: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(agency().usageRebillingEnabled).toBe(true);
    expect(auditRows()).toHaveLength(1);
  });
});

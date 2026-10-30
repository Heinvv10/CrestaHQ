import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency PATCH `usagePaywallEnabled`: the setting that lets an overdue usage
 * charge wall a client workspace. Owner only, boolean only, live owner row
 * re-checked on enable, an agency-level audit event per real change, and
 * every flagged client re-checked so the flip takes effect at once. Real
 * route over an in-memory Firestore.
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
const auditRows = () => db().list("auditEvents").filter((r) => r.action === "usage_paywall.updated");
const flag = (id: string) => db().read(`subAccounts/${id}`)?.usageOverdue as { paywall?: boolean } | null | undefined;

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
  db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usageRebillingEnabled: true });
  db().seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
});

describe("usagePaywallEnabled", () => {
  it("a non-owner cannot set it (403)", async () => {
    expect((await patch("staff1", { usagePaywallEnabled: true })).status).toBe(403);
    expect(agency()).not.toHaveProperty("usagePaywallEnabled");
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a non-boolean", async () => {
    for (const bad of ["on", 1, null]) {
      expect((await patch("owner1", { usagePaywallEnabled: bad })).status).toBe(400);
    }
    expect(agency()).not.toHaveProperty("usagePaywallEnabled");
  });

  it("an owner whose agencyMembers row was removed cannot switch it on, but can switch it off", async () => {
    db().seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "removed" });
    expect((await patch("owner1", { usagePaywallEnabled: true })).status).toBe(403);
    expect(agency()).not.toHaveProperty("usagePaywallEnabled");
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usagePaywallEnabled: true });
    expect((await patch("owner1", { usagePaywallEnabled: false })).status).toBe(200);
    expect(agency().usagePaywallEnabled).toBe(false);
  });

  it("the owner switches it on: stored, one agency-level audit event; saving the same value again audits nothing", async () => {
    expect((await patch("owner1", { usagePaywallEnabled: true })).status).toBe(200);
    expect(agency().usagePaywallEnabled).toBe(true);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor: { type: "user", id: "owner1" },
      target: { type: "agency", id: "ag1" },
      agencyId: "ag1",
      subAccountId: null,
      changes: [{ field: "usagePaywallEnabled", before: false, after: true }],
    });
    expect((await patch("owner1", { usagePaywallEnabled: true })).status).toBe(200);
    expect(auditRows()).toHaveLength(1);
  });

  it("is the only change needed in a request (no 'No fields to update')", async () => {
    expect((await patch("owner1", { usagePaywallEnabled: false })).status).toBe(200);
  });

  it("flipping it re-checks this agency's flagged clients, and only this agency's", async () => {
    const since = new Date(2026, 8, 1);
    const standing = { chargeId: "usage_x_2026-09", since, amountCents: 5000, currency: "zar", usageMonth: "2026-09" };
    for (const [id, agencyId] of [["sa1", "ag1"], ["sb1", "ag2"]] as const) {
      db().seed(`subAccounts/${id}`, { agencyId, usageRebillingEnabled: true, usageOverdue: { ...standing, paywall: true } });
    }
    db().seed("agencies/ag2", { usageRebillingEnabled: true, usagePaywallEnabled: true });
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", usageRebillingEnabled: true, usagePaywallEnabled: true });
    db().seed("billingCharges/usage_x_2026-09", {
      subAccountId: "sa1", agencyId: "ag1", kind: "usage", status: "pending", emailedTo: "a@b.co", dueAt: since,
      amountCents: 5000, currency: "zar", usageMonth: "2026-09",
    });
    expect((await patch("owner1", { usagePaywallEnabled: false })).status).toBe(200);
    expect(flag("sa1")?.paywall).toBe(false);
    expect(flag("sb1")?.paywall).toBe(true);
  });
});

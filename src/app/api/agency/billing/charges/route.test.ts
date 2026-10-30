import { beforeEach, describe, expect, it, vi } from "vitest";

/** GET /api/agency/billing/charges: the owner's Invoices table, scoped to the caller's own agency. */

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

const { GET } = await import("./route");
const db = () => mem.ref!;
const get = (uid?: string) =>
  GET(new Request("http://x/api/agency/billing/charges", { headers: uid ? { "x-user-uid": uid } : {} }));
const row = (agencyId: string, extra: Record<string, unknown>) => ({
  agencyId, subAccountId: "sa1", description: "d", amountCents: 100, currency: "zar", status: "pending", ...extra,
});

beforeEach(() => {
  db().clear();
  db().seed("billingCharges/a", row("ag1", { kind: "usage", usageMonth: "2026-09", createdAt: new Date(2026, 9, 1), dueAt: new Date(2026, 9, 15) }));
  db().seed("billingCharges/b", row("ag1", { createdAt: new Date(2026, 9, 3) }));
  db().seed("billingCharges/other", row("ag2", { createdAt: new Date(2026, 9, 2) }));
});

describe("agency charges list", () => {
  it("an unauthenticated caller gets 401 and a staff member 403", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("staff1")).status).toBe(403);
  });

  it("the owner sees only their own agency's charges, newest first, with usage fields", async () => {
    const res = await get("owner1");
    expect(res.status).toBe(200);
    const { charges } = (await res.json()) as { charges: { id: string; kind: string; usageMonth: string | null; dueAt: string | null }[] };
    expect(charges.map((c) => c.id)).toEqual(["b", "a"]);
    expect(charges[1]).toMatchObject({ kind: "usage", usageMonth: "2026-09" });
    expect(new Date(charges[1].dueAt!).getTime()).toBe(new Date(2026, 9, 15).getTime());
  });

  it("never returns a token or pay link", async () => {
    db().seed("billingCharges/a", { ...db().read("billingCharges/a")!, tokenHash: "h", payUrl: "https://x/pay/charge/t" });
    expect(JSON.stringify(await (await get("owner1")).json())).not.toMatch(/tokenHash|payUrl|pay\/charge/);
  });
});

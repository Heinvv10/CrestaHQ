import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Re-tagging a contact carries its territoryId onto the agent proposals that
 * target it: firestore.rules scope those rows by the copied territoryId, so a
 * stale copy would show the row to the old territory's reps.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "admin" }),
}));

const { PATCH } = await import("./route");

beforeEach(() => {
  mem.clear();
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", territoryId: "south" });
  mem.seed("subAccounts/sa1/territories/north", { status: "active", name: "North" });
  for (const [id, status] of [["p_pending", "pending"], ["p_unsettled", "unsettled"], ["p_done", "executed"]]) {
    mem.seed(`agentProposals/${id}`, { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", territoryId: "south", status });
  }
  mem.seed("agentProposals/p_other", { agencyId: "ag1", subAccountId: "sa1", contactId: "c2", territoryId: "south", status: "pending" });
});

it("moves the contact's proposals to the new territory, and only those", async () => {
  const res = await PATCH(
    new Request("https://crm.test", { method: "PATCH", body: JSON.stringify({ territoryId: "north" }) }),
    { params: Promise.resolve({ id: "sa1", contactId: "c1" }) }
  );
  expect(res.status).toBe(200);
  expect((await res.json()).moved).toMatchObject({ agentProposals: 3 });
  for (const id of ["p_pending", "p_unsettled", "p_done"]) {
    expect(mem.read(`agentProposals/${id}`)?.territoryId).toBe("north");
  }
  expect(mem.read("agentProposals/p_other")?.territoryId).toBe("south");
});

it("catches a proposal created after the contact commit, while the cascade runs", async () => {
  const original = mem.db.runTransaction.bind(mem.db);
  vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
    const result = await original(fn as Parameters<typeof original>[0]);
    // Proposed right after the contact moved, having read the old territory.
    mem.seed("agentProposals/p_mid", { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", territoryId: "south", status: "pending" });
    return result;
  });
  await PATCH(
    new Request("https://crm.test", { method: "PATCH", body: JSON.stringify({ territoryId: "north" }) }),
    { params: Promise.resolve({ id: "sa1", contactId: "c1" }) }
  );
  expect(mem.read("agentProposals/p_mid")?.territoryId).toBe("north");
});

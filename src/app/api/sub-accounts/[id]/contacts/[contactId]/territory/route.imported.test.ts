import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Moving a contact to another territory moves its deals, quotes, tasks and
 * bookings with it — but not an event imported from a member's Google
 * Calendar: that follows its owner, not the contact.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: async () => ({ uid: "admin" }) }));

const { PATCH } = await import("./route");

const own = { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", territoryId: "global" };
beforeEach(() => {
  mem.clear();
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", territoryId: "global", name: "Ann" });
  mem.seed("subAccounts/sa1/territories/north", { name: "North", status: "active" });
  mem.seed("events/b1", { ...own, source: "booking_page" });
  mem.seed("events/g1", { ...own, source: "google" });
});

it("moves the contact's booking but not its imported Google event", async () => {
  const res = await PATCH(
    new Request("https://crm.test", { method: "PATCH", body: JSON.stringify({ territoryId: "north" }) }),
    { params: Promise.resolve({ id: "sa1", contactId: "c1" }) },
  );
  expect(res.status).toBe(200);
  expect((await res.json()).moved).toMatchObject({ events: 1 });
  expect(mem.read("events/b1")?.territoryId).toBe("north");
  expect(mem.read("events/g1")?.territoryId).toBe("global");
});

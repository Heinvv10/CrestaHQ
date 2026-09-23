import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH /api/contacts/[id] applies the contacts read rule's territory clause:
 * a scoped collaborator cannot edit a contact outside their territories.
 * Real territory-filter; Firestore is in-memory, the write service a spy.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({
  role: "collaborator" as string,
  update: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db, getAdminAuth: () => ({}) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_r: Request, subAccountId: string) => ({
    uid: "u1",
    subAccountId,
    subAccountRole: t.role,
  }),
}));
vi.mock("@/lib/server/contacts-service", () => ({ updateContactServerSide: t.update }));
vi.mock("@/lib/server/contact-delete", () => ({
  deleteContactServerSide: vi.fn(),
  findContactBlockers: vi.fn(),
}));

const { PATCH } = await import("./route");
const patch = (id: string) =>
  PATCH(
    new Request(`http://x/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.update.mockReset().mockResolvedValue({ contact: { id: "x" } });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/in", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/out", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
});

it("refuses a scoped collaborator an out-of-territory contact and writes nothing", async () => {
  expect((await patch("out")).status).toBe(403);
  expect(t.update).not.toHaveBeenCalled();
});

it("lets a scoped collaborator edit a contact in their territory", async () => {
  expect((await patch("in")).status).toBe(200);
  expect(t.update).toHaveBeenCalledTimes(1);
});

it("does not scope an admin", async () => {
  t.role = "admin";
  expect((await patch("out")).status).toBe(200);
});

import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * POST /api/events refuses a scoped collaborator an event on an
 * out-of-territory contact. Real territory-filter; in-memory Firestore.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({ role: "collaborator" as string, create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_r: Request, subAccountId: string) => ({
    uid: "u1",
    subAccountId,
    agencyId: "ag1",
    subAccountRole: t.role,
  }),
}));
vi.mock("@/lib/server/events-service", () => ({ createEventServerSide: t.create }));

const { POST } = await import("./route");
const create = (contactId: string) =>
  POST(
    new Request("http://x/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subAccountId: "sa1",
        title: "Visit",
        startAt: "2026-10-01T09:00:00Z",
        endAt: "2026-10-01T10:00:00Z",
        contactId,
      }),
    }),
  );

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.create.mockReset().mockResolvedValue({ id: "e", event: {} });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/cIn", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/cOut", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
});

it("refuses a scoped collaborator an event on an out-of-territory contact", async () => {
  expect((await create("cOut")).status).toBe(403);
  expect(t.create).not.toHaveBeenCalled();
});

it("allows an in-territory contact, and an admin anywhere", async () => {
  expect((await create("cIn")).status).toBe(201);
  t.role = "admin";
  expect((await create("cOut")).status).toBe(201);
});

import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Test-enrolling a contact in a workflow runs real actions against it, so a
 * scoped collaborator is refused an out-of-territory contact.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({ role: "collaborator" as string, enroll: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_r: Request, subAccountId: string) => ({
    uid: "u1",
    subAccountId,
    subAccountRole: t.role,
  }),
}));
vi.mock("@/lib/workflows/engine", () => ({ enrollForTest: t.enroll }));

const { POST } = await import("./route");
const enroll = (contactId: string) =>
  POST(
    new Request("http://x/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId }),
    }),
    { params: Promise.resolve({ id: "sa1", workflowId: "w1" }) },
  );

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.enroll.mockReset().mockResolvedValue({ ok: true });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/cIn", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/cOut", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
});

it("refuses a scoped collaborator an out-of-territory contact", async () => {
  expect((await enroll("cOut")).status).toBe(403);
  expect(t.enroll).not.toHaveBeenCalled();
});

it("allows an in-territory contact, and an admin anywhere", async () => {
  expect((await enroll("cIn")).status).toBe(200);
  t.role = "admin";
  expect((await enroll("cOut")).status).toBe(200);
});

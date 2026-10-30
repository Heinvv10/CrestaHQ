import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Task routes apply the territory read rule: a scoped collaborator can't
 * create a task on an out-of-territory contact, nor complete an
 * out-of-territory task. Real territory-filter; in-memory Firestore.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({ role: "collaborator" as string, create: vi.fn(), complete: vi.fn() }));
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
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: t.create,
  setTaskCompletedServerSide: t.complete,
}));

const { POST } = await import("./route");
const { POST: COMPLETE } = await import("./[id]/complete/route");

const req = (body: unknown) =>
  new Request("http://x/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const create = (contactId: string) => POST(req({ subAccountId: "sa1", title: "Call", contactId }));
const complete = (id: string) => COMPLETE(req({ completed: true }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.create.mockReset().mockResolvedValue({ id: "k", task: {} });
  t.complete.mockReset().mockResolvedValue({ task: {} });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/cIn", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/cOut", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
  mem.seed("tasks/in", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("tasks/out", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
});

describe("POST /api/tasks", () => {
  it("refuses a scoped collaborator a task on an out-of-territory contact", async () => {
    expect((await create("cOut")).status).toBe(403);
    expect(t.create).not.toHaveBeenCalled();
  });
  it("allows an in-territory contact, and an admin anywhere", async () => {
    expect((await create("cIn")).status).toBe(201);
    t.role = "admin";
    expect((await create("cOut")).status).toBe(201);
  });
});

describe("POST /api/tasks/[id]/complete", () => {
  it("refuses a scoped collaborator an out-of-territory task", async () => {
    expect((await complete("out")).status).toBe(403);
    expect(t.complete).not.toHaveBeenCalled();
  });
  it("allows an in-territory task, and an admin anywhere", async () => {
    expect((await complete("in")).status).toBe(200);
    t.role = "admin";
    expect((await complete("out")).status).toBe(200);
  });
});

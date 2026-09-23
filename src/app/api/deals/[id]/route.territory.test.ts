import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Deal routes apply the deals read rule's territory clause, and a scoped
 * collaborator may not re-home a deal (territoryIdUnchangedOrAdmin) or create
 * one outside their territories. Real territory-filter; in-memory Firestore.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({
  role: "collaborator" as string,
  update: vi.fn(),
  del: vi.fn(),
  create: vi.fn(),
}));
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
vi.mock("@/lib/server/deals-service", () => ({
  DealStageError: class extends Error {},
  updateDealServerSide: t.update,
  deleteDealServerSide: t.del,
  createDealServerSide: t.create,
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn() }));
vi.mock("@/lib/custom-fields/load-defs", () => ({ loadCustomFieldDefs: async () => [] }));
vi.mock("@/lib/pipelines/server", () => ({
  loadPipeline: async () => ({ id: "default", stages: [{ id: "new" }] }),
}));
vi.mock("@/lib/pipelines/stages", () => ({
  dealPipelineId: () => "default",
  findStage: (_p: unknown, id: string) => (id === "new" ? { id } : undefined),
}));

const { PATCH, DELETE } = await import("./route");
const { POST } = await import("../route");

const json = (method: string, url: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const patch = (id: string, body: unknown) =>
  PATCH(json("PATCH", `http://x/api/deals/${id}`, body), { params: Promise.resolve({ id }) });
const del = (id: string) =>
  DELETE(json("DELETE", `http://x/api/deals/${id}`), { params: Promise.resolve({ id }) });
const create = (body: Record<string, unknown>) =>
  POST(json("POST", "http://x/api/deals", { subAccountId: "sa1", title: "D", stageId: "new", ...body }));

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.update.mockReset().mockResolvedValue({ deal: { id: "d" }, stageTerminal: null });
  t.del.mockReset().mockResolvedValue(undefined);
  t.create.mockReset().mockResolvedValue({ id: "new", deal: {} });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/cIn", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/cOut", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
  mem.seed("deals/in", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1", contactId: "cIn", stageId: "new" });
  mem.seed("deals/out", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2", contactId: "cOut", stageId: "new" });
});

describe("PATCH / DELETE /api/deals/[id]", () => {
  it("refuses a scoped collaborator an out-of-territory deal", async () => {
    expect((await patch("out", { title: "x" })).status).toBe(403);
    expect((await del("out")).status).toBe(403);
    expect(t.update).not.toHaveBeenCalled();
    expect(t.del).not.toHaveBeenCalled();
  });

  it("lets a scoped collaborator edit and delete an in-territory deal", async () => {
    expect((await patch("in", { title: "x", territoryId: "t1" })).status).toBe(200);
    expect((await del("in")).status).toBe(200);
  });

  it("refuses a scoped collaborator moving a deal to another territory or contact", async () => {
    expect((await patch("in", { territoryId: "t2" })).status).toBe(403);
    expect((await patch("in", { territoryId: null })).status).toBe(403);
    expect((await patch("in", { contactId: "cOut" })).status).toBe(403);
    expect(t.update).not.toHaveBeenCalled();
  });

  it("does not scope an admin", async () => {
    t.role = "admin";
    expect((await patch("out", { territoryId: "t1" })).status).toBe(200);
    expect((await del("out")).status).toBe(200);
  });
});

describe("POST /api/deals", () => {
  it("refuses a scoped collaborator a deal on an out-of-territory contact or territory", async () => {
    expect((await create({ contactId: "cOut", territoryId: "t2" })).status).toBe(403);
    expect((await create({ contactId: "cIn", territoryId: "t2" })).status).toBe(403);
    // The contact gate on its own: an in-scope territory can't launder an
    // out-of-territory contact.
    expect((await create({ contactId: "cOut", territoryId: "t1" })).status).toBe(403);
    expect((await create({ contactId: "cOut", territoryId: "global" })).status).toBe(403);
    expect(t.create).not.toHaveBeenCalled();
  });

  it("lets a scoped collaborator create in their territory", async () => {
    expect((await create({ contactId: "cIn", territoryId: "t1" })).status).toBe(201);
    expect(t.create).toHaveBeenCalledWith(expect.objectContaining({ territoryId: "t1" }));
  });

  it("does not scope an admin", async () => {
    t.role = "admin";
    expect((await create({ contactId: "cOut", territoryId: "t2" })).status).toBe(201);
  });
});

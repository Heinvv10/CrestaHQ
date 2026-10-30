import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The dashboard deal routes (the Kanban drag, the edit dialog, New deal)
 * append a stage-history row through the REAL routes and deals service over
 * an in-memory Firestore. Stubbed: the session check, webhooks, workflows.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u_member", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

const rows = () => mem.list("dealStageHistory");
const json = (method: string, url: string, body: unknown) =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
});

it("New deal (POST /api/deals) writes the entry row", async () => {
  const res = await POST(json("POST", "http://x/api/deals", {
    subAccountId: "sa1", title: "Fibre", contactId: "c1", stageId: "new",
  }));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(rows()).toEqual([
    expect.objectContaining({ dealId: id, stageId: "new", fromStageId: null, source: "app", createdByUid: "u_member" }),
  ]);
});

it("a Kanban drag (PATCH /api/deals/:id stageId) appends a move row; a field edit does not", async () => {
  mem.seed("deals/d1", {
    title: "D", value: 1, currency: "USD", contactId: "c1", stageId: "new",
    subAccountId: "sa1", agencyId: "ag1", mode: "live",
  });
  const patch = (body: unknown) =>
    PATCH(json("PATCH", "http://x/api/deals/d1", body), { params: Promise.resolve({ id: "d1" }) });

  expect((await patch({ title: "Renamed" })).status).toBe(200);
  expect(rows()).toEqual([]);

  expect((await patch({ stageId: "lost", lostReason: "price" })).status).toBe(200);
  expect(rows()).toEqual([
    expect.objectContaining({
      dealId: "d1", fromStageId: "new", stageId: "lost", source: "app", createdByUid: "u_member",
      agencyId: "ag1", subAccountId: "sa1",
    }),
  ]);
});

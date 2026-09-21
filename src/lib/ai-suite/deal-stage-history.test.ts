import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The AI Suite's create_deal and move_deal_stage capabilities append
 * stage-history rows, through their real execute() and the real deals
 * service over an in-memory Firestore. Stubbed: webhooks and workflows.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { getCapability } = await import("./capabilities");

const ctx = {
  uid: "u_ai", email: "a@example.com", displayName: "A", agencyId: "ag1",
  subAccountId: "sa1", subAccountRole: "admin",
};

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
});

it("create_deal writes the entry row and move_deal_stage appends a move row", async () => {
  const created = await getCapability("create_deal")!.execute(ctx, {
    title: "Fibre", value: 5, currency: "USD", contactId: "c1", contactName: "Ann", stage: "new",
  });
  const id = created.ref!.id;
  await getCapability("move_deal_stage")!.execute(ctx, {
    dealId: id, dealTitle: "Fibre", stage: "proposal", lostReason: "",
  });
  expect(mem.list("dealStageHistory")).toEqual([
    expect.objectContaining({ dealId: id, fromStageId: null, stageId: "new", source: "ai", createdByUid: "u_ai" }),
    expect.objectContaining({ dealId: id, fromStageId: "new", stageId: "proposal", source: "ai", createdByUid: "u_ai" }),
  ]);
});

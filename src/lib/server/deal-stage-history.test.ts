import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Stage history through the real deals service over an in-memory Firestore:
 * which writes append a row, what the row says, and that concurrent moves
 * chain (each row's fromStageId is the stage the deal actually left).
 * Stubbed: webhooks and the workflow engine.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { createDealServerSide, updateDealServerSide } = await import("./deals-service");

const rows = (dealId: string) =>
  mem.list("dealStageHistory").filter((r) => r.dealId === dealId);

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "renewed", label: "Renewed", tone: "", terminal: "won" },
    ],
  });
});

const create = () =>
  createDealServerSide({
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", mode: "live", source: "app",
    title: "Deal", value: 10, currency: "USD", contactId: "c1", stageId: "new", priority: "medium",
  });
const update = (dealId: string, patch: Record<string, unknown>) =>
  updateDealServerSide({ dealId, patch, userId: "u2", source: "app" });

describe("deal stage history", () => {
  it("a created deal gets one entry row with no from-stage, carrying tenancy", async () => {
    const { id } = await create();
    expect(rows(id)).toEqual([
      expect.objectContaining({
        agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", mode: "live", source: "app",
        dealId: id, pipelineId: "default", stageId: "new",
        fromPipelineId: null, fromStageId: null, fromStageEnteredAt: null,
      }),
    ]);
  });

  it("a move appends a row: from/to stage, the mover, and when the left stage was entered", async () => {
    const { id } = await create();
    const enteredNew = mem.read(`deals/${id}`)!.stageChangedAt;
    await update(id, { stageId: "qualified" });
    const move = rows(id).find((r) => r.fromStageId === "new")!;
    expect(move).toMatchObject({
      createdByUid: "u2", stageId: "qualified", fromStageId: "new",
      pipelineId: "default", fromPipelineId: "default",
    });
    expect(move.fromStageEnteredAt).toEqual(enteredNew);
    // One server timestamp per commit in Firestore; the memory store stamps
    // each field with its own Date, so compare to the millisecond window.
    const enteredAt = (move.enteredAt as Date).getTime();
    const stageChangedAt = (mem.read(`deals/${id}`)!.stageChangedAt as Date).getTime();
    expect(Math.abs(enteredAt - stageChangedAt)).toBeLessThan(50);
  });

  it("an edit that does not change the stage writes no row", async () => {
    const { id } = await create();
    await update(id, { title: "Renamed", value: 99 });
    await update(id, { stageId: "new" });
    expect(rows(id)).toHaveLength(1);
  });

  it("a pipeline move and a reopen from Lost are both moves", async () => {
    const { id } = await create();
    await update(id, { pipelineId: "p2", stageId: "open" });
    expect(rows(id).at(-1)).toMatchObject({
      fromPipelineId: "default", fromStageId: "new", pipelineId: "p2", stageId: "open",
    });

    mem.seed("deals/d_lost", {
      title: "L", contactId: "c1", subAccountId: "sa1", agencyId: "ag1", mode: "live",
      stageId: "lost", lostReason: "price",
    });
    await update("d_lost", { stageId: "proposal" });
    expect(rows("d_lost")).toEqual([
      expect.objectContaining({ fromStageId: "lost", stageId: "proposal" }),
    ]);
  });

  it("concurrent moves chain — no two rows leave the same stage", async () => {
    const { id } = await create();
    await Promise.all([update(id, { stageId: "qualified" }), update(id, { stageId: "proposal" })]);
    const moves = rows(id).filter((r) => r.fromStageId !== null);
    expect(moves).toHaveLength(2);
    expect(new Set(moves.map((r) => r.fromStageId)).size).toBe(2);
    const last = moves.find((r) => r.stageId === mem.read(`deals/${id}`)!.stageId)!;
    const first = moves.find((r) => r !== last)!;
    expect([first.fromStageId, last.fromStageId]).toEqual(["new", first.stageId]);
  });
});

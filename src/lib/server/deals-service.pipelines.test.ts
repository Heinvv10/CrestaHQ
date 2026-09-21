import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The deal lifecycle triggers, driven through the real service over an
 * in-memory Firestore (real pipeline resolution). Stubbed: webhooks and
 * the workflow engine — the assertion is WHICH trigger fired with WHAT
 * context, not what the engine did with it.
 */

const mem = createMemoryFirestore();
const fired: Array<{ type: string; contactId: string; context?: Record<string, unknown> }> = [];
const webhooks: string[] = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: async (e: { type: string }) => {
    webhooks.push(e.type);
  },
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async (input: (typeof fired)[number]) => {
    fired.push(input);
    return { enrolled: [], skipped: [], reason: null };
  },
}));

const { DealStageError, createDealServerSide, updateDealServerSide } = await import(
  "./deals-service"
);

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  mem.clear();
  fired.length = 0;
  webhooks.length = 0;
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ownerUid: "u1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals",
    isDefault: false,
    agencyId: "ag1",
    subAccountId: "sa1",
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "renewed", label: "Renewed", tone: "", terminal: "won" },
      { id: "churned", label: "Churned", tone: "", terminal: "lost" },
    ],
  });
});

const base = {
  subAccountId: "sa1",
  agencyId: "ag1",
  createdByUid: "u1",
  mode: "live" as const,
  title: "Deal",
  value: 10,
  currency: "USD",
  contactId: "c1",
  priority: "medium" as const,
  source: "app" as const,
};

describe("createDealServerSide", () => {
  it("writes pipelineId (default when absent) and fires deal.created with it", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "new" });
    expect(mem.read(`deals/${id}`)?.pipelineId).toBe("default");
    expect(fired).toEqual([
      expect.objectContaining({
        type: "deal.created",
        contactId: "c1",
        context: { dealId: id, pipelineId: "default", toStage: "new" },
      }),
    ]);
    // The default pipeline was seeded by the read.
    expect(mem.read("subAccounts/sa1/pipelines/default")?.isDefault).toBe(true);
  });

  it("does not fire workflow triggers in test mode", async () => {
    await createDealServerSide({ ...base, mode: "test", stageId: "new" });
    expect(fired).toEqual([]);
  });
});

describe("updateDealServerSide — stage moves", () => {
  it("fires pipeline.stage.changed with pipelineId + fromStage + toStage", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "open", pipelineId: "p2" });
    fired.length = 0;
    await updateDealServerSide({ dealId: id, patch: { stageId: "renewed" }, userId: "u1", source: "app" });
    await tick();
    expect(fired.map((f) => f.type)).toEqual(["pipeline.stage.changed", "deal.won"]);
    expect(fired[0].context).toEqual({
      dealId: id,
      pipelineId: "p2",
      fromStage: "open",
      toStage: "renewed",
    });
  });

  it("won / lost come from the stage's terminal flag, not the literal id", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "open", pipelineId: "p2" });
    fired.length = 0;
    webhooks.length = 0;
    await updateDealServerSide({
      dealId: id,
      patch: { stageId: "churned", lostReason: "price" },
      userId: "u1", source: "app",
    });
    await tick();
    expect(fired.map((f) => f.type)).toEqual(["pipeline.stage.changed", "deal.lost"]);
    expect(webhooks).toContain("deal.lost");
    expect(mem.read(`deals/${id}`)?.lostReason).toBe("price");

    // Back to an open stage: no won/lost, reason cleared.
    fired.length = 0;
    await updateDealServerSide({ dealId: id, patch: { stageId: "open" }, userId: "u1", source: "app" });
    await tick();
    expect(fired.map((f) => f.type)).toEqual(["pipeline.stage.changed"]);
    expect(mem.read(`deals/${id}`)?.lostReason).toBeNull();
  });

  it("a pre-pipeline deal (no pipelineId) resolves to the default's won stage", async () => {
    mem.seed("deals/legacy", {
      ...base, stageId: "proposal", lostReason: null, subAccountId: "sa1", agencyId: "ag1",
    });
    await updateDealServerSide({ dealId: "legacy", patch: { stageId: "won" }, userId: "u1", source: "app" });
    await tick();
    expect(fired.map((f) => f.type)).toEqual(["pipeline.stage.changed", "deal.won"]);
    expect(fired[0].context?.pipelineId).toBe("default");
    expect(mem.read("deals/legacy")?.pipelineId).toBe("default");
  });

  it("rejects a stage id the deal's pipeline does not have — nothing written, nothing fired", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "open", pipelineId: "p2" });
    fired.length = 0;
    // "won" is a DEFAULT-pipeline id; p2's won stage is "renewed".
    await expect(
      updateDealServerSide({ dealId: id, patch: { stageId: "won" }, userId: "u1", source: "app" }),
    ).rejects.toBeInstanceOf(DealStageError);
    await tick();
    expect(mem.read(`deals/${id}`)?.stageId).toBe("open");
    expect(fired).toEqual([]);
  });

  it("terminal:'won' resolves to the deal's own pipeline's won stage", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "open", pipelineId: "p2" });
    fired.length = 0;
    const res = await updateDealServerSide({
      dealId: id,
      patch: { terminal: "won", value: 99 },
      userId: "u1", source: "app",
    });
    await tick();
    expect(res?.stage.id).toBe("renewed");
    expect(mem.read(`deals/${id}`)).toMatchObject({ stageId: "renewed", value: 99 });
    expect(fired.map((f) => f.type)).toEqual(["pipeline.stage.changed", "deal.won"]);
  });

  it("terminal:'won' on a pipeline without a won stage is refused", async () => {
    mem.seed("subAccounts/sa1/pipelines/p3", {
      name: "Open only", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
      stages: [{ id: "a", label: "A", tone: "" }],
    });
    const { id } = await createDealServerSide({ ...base, stageId: "a", pipelineId: "p3" });
    await expect(
      updateDealServerSide({ dealId: id, patch: { terminal: "won" }, userId: "u1", source: "app" }),
    ).rejects.toMatchObject({ code: "no_terminal_stage" });
  });

  it("a pipeline move needs a stage; unknown pipeline is refused", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "new" });
    await expect(
      updateDealServerSide({ dealId: id, patch: { pipelineId: "p2" }, userId: "u1", source: "app" }),
    ).rejects.toMatchObject({ code: "invalid_stage" });
    await expect(
      updateDealServerSide({ dealId: id, patch: { pipelineId: "nope", stageId: "x" }, userId: "u1", source: "app" }),
    ).rejects.toMatchObject({ code: "invalid_pipeline" });
    const moved = await updateDealServerSide({
      dealId: id, patch: { pipelineId: "p2", stageId: "open" }, userId: "u1", source: "app",
    });
    expect(moved?.deal.pipeline_id).toBe("p2");
    expect(mem.read(`deals/${id}`)).toMatchObject({ pipelineId: "p2", stageId: "open" });
  });

  it("create refuses a stage the pipeline lacks", async () => {
    await expect(
      createDealServerSide({ ...base, stageId: "renewed" }),
    ).rejects.toMatchObject({ code: "invalid_stage" });
    expect(mem.list("deals")).toHaveLength(0);
  });

  it("a field-only edit fires nothing", async () => {
    const { id } = await createDealServerSide({ ...base, stageId: "new" });
    fired.length = 0;
    await updateDealServerSide({ dealId: id, patch: { title: "Renamed" }, userId: "u1", source: "app" });
    await tick();
    expect(fired).toEqual([]);
  });
});

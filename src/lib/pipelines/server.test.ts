import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { PIPELINE_STAGES } from "@/types/deals";

/**
 * Default-pipeline resolution. A sub-account that predates pipelines must
 * resolve "no pipelineId" to a default whose stage ids are the canonical
 * six — otherwise every stored `toStage` / `move_stage` config stops
 * matching the day this ships.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { countDeals, ensureDefaultPipeline, loadPipeline } = await import("./server");

const CANONICAL = PIPELINE_STAGES.map((s) => s.id);

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ownerUid: "u1" });
});

describe("ensureDefaultPipeline", () => {
  it("seeds pipelines/default with the canonical stage ids and tenancy keys", async () => {
    const p = await ensureDefaultPipeline("sa1");
    expect(p?.id).toBe("default");
    expect(p?.stages.map((s) => s.id)).toEqual(CANONICAL);
    const stored = mem.read("subAccounts/sa1/pipelines/default");
    expect(stored).toMatchObject({
      isDefault: true,
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "u1",
    });
  });

  it("applies the legacy label/order overrides without changing ids", async () => {
    mem.seed("subAccounts/sa1", {
      agencyId: "ag1",
      pipelineStages: [
        { id: "new", label: "Lead", order: 5 },
        { id: "won", label: "Closed", order: 0 },
      ],
    });
    const p = await ensureDefaultPipeline("sa1");
    expect(p?.stages[0]).toMatchObject({ id: "won", label: "Closed", terminal: "won" });
    expect(p?.stages.map((s) => s.id).sort()).toEqual([...CANONICAL].sort());
    expect(p?.stages.find((s) => s.id === "new")?.label).toBe("Lead");
  });

  it("is idempotent — a second call returns the stored doc untouched", async () => {
    await ensureDefaultPipeline("sa1");
    await mem.db.doc("subAccounts/sa1/pipelines/default").update({ name: "Sales" });
    const again = await ensureDefaultPipeline("sa1");
    expect(again?.name).toBe("Sales");
    expect(mem.list("subAccounts/sa1/pipelines")).toHaveLength(1);
  });

  it("returns null for a missing sub-account and writes nothing", async () => {
    expect(await ensureDefaultPipeline("nope")).toBeNull();
    expect(mem.list("subAccounts/nope/pipelines")).toHaveLength(0);
  });
});

describe("loadPipeline", () => {
  it("absent id ⇒ the default pipeline", async () => {
    const p = await loadPipeline("sa1", undefined);
    expect(p?.id).toBe("default");
    expect(p?.stages.map((s) => s.id)).toEqual(CANONICAL);
  });

  it("a named pipeline comes back by id; an unknown one is null", async () => {
    mem.seed("subAccounts/sa1/pipelines/p2", {
      name: "Renewals",
      stages: [{ id: "open", label: "Open", tone: "" }],
      isDefault: false,
    });
    expect((await loadPipeline("sa1", "p2"))?.name).toBe("Renewals");
    expect(await loadPipeline("sa1", "missing")).toBeNull();
  });
});

describe("countDeals", () => {
  it("counts deals with no pipelineId as the default's, per stage", async () => {
    mem.seed("deals/d1", { subAccountId: "sa1", stageId: "new" });
    mem.seed("deals/d2", { subAccountId: "sa1", stageId: "new", pipelineId: "default" });
    mem.seed("deals/d3", { subAccountId: "sa1", stageId: "new", pipelineId: "p2" });
    mem.seed("deals/d4", { subAccountId: "sa1", stageId: "won" });
    mem.seed("deals/d5", { subAccountId: "other", stageId: "new" });
    expect(await countDeals("sa1", "default", "new")).toBe(2);
    expect(await countDeals("sa1", "default")).toBe(3);
    expect(await countDeals("sa1", "p2")).toBe(1);
  });
});

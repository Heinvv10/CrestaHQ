import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * move_stage with a pipeline chosen moves the contact's deal in it — through
 * the real deals service, so `deal.stage.changed` and the
 * `pipeline.stage.changed` trigger behave as a manual move. Real `runStep`,
 * real deals service, real pipelines lib, in-memory Firestore; outbound
 * webhooks are captured and QStash is stubbed.
 */

const mem = createMemoryFirestore();
const webhooks: Array<{ type: string; dealId: string }> = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: async (e: { type: string; payload: { deal: { id: string } } }) => {
    webhooks.push({ type: e.type, dealId: e.payload.deal.id });
  },
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));

const { runStep } = await import("./engine");

const flush = () => new Promise((r) => setTimeout(r, 30));
const at = (iso: string) => new Date(iso);

function seedRun(config: Record<string, unknown>, context: Record<string, unknown> = {}) {
  mem.seed("workflows/wf1", {
    name: "Mover", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "move_stage", next: null, config } },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1",
    contactId: "c1", status: "running", currentNodeId: "n1", history: [], context,
  });
}

function seedDeal(id: string, data: Record<string, unknown>) {
  mem.seed(`deals/${id}`, {
    title: id, value: 1, currency: "USD", contactId: "c1", priority: "medium",
    subAccountId: "sa1", agencyId: "ag1", mode: "live", ...data,
  });
}

const stepLog = () =>
  (mem.read("workflowRuns/run1")?.history as Array<{ result: string }>)[0]?.result;
const stageOf = (id: string) => mem.read(`deals/${id}`)?.stageId;

beforeEach(() => {
  mem.clear();
  webhooks.length = 0;
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi", tags: [],
  });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Installs", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
    stages: [
      { id: "booked", label: "Booked", tone: "" },
      { id: "installed", label: "Installed", tone: "" },
      { id: "done", label: "Done", tone: "", terminal: "won" },
      { id: "dropped", label: "Dropped", tone: "", terminal: "lost" },
    ],
  });
});

describe("move_stage moves the contact's deal", () => {
  it("moves the most recently updated open deal in the chosen pipeline, through the deals service", async () => {
    seedDeal("older", { pipelineId: "p2", stageId: "booked", updatedAt: at("2026-09-01") });
    seedDeal("newer", { pipelineId: "p2", stageId: "booked", updatedAt: at("2026-09-10") });
    seedDeal("otherPipe", { pipelineId: "default", stageId: "new", updatedAt: at("2026-09-12") });
    seedDeal("otherContact", {
      pipelineId: "p2", stageId: "booked", contactId: "c2", updatedAt: at("2026-09-13"),
    });
    seedDeal("otherTenant", {
      pipelineId: "p2", stageId: "booked", subAccountId: "sa2", updatedAt: at("2026-09-13"),
    });
    seedRun({ stage: "installed", pipelineId: "p2" });

    await runStep("run1", "n1");
    await flush();

    expect(stageOf("newer")).toBe("installed");
    expect(mem.read("deals/newer")?.stageChangedAt).toBeInstanceOf(Date);
    for (const id of ["older", "otherContact", "otherTenant"]) expect(stageOf(id)).toBe("booked");
    expect(stageOf("otherPipe")).toBe("new");
    expect(mem.read("contacts/c1")?.pipelineStage).toBe("installed");
    expect(stepLog()).toBe("stage:installed;deal:moved:newer");
    await vi.waitFor(() =>
      expect(webhooks).toEqual([
        { type: "deal.updated", dealId: "newer" },
        { type: "deal.stage.changed", dealId: "newer" },
      ])
    );
  });

  it("the move fires pipeline.stage.changed like a manual move, carrying the hop count", async () => {
    seedDeal("d1", { pipelineId: "p2", stageId: "booked" });
    mem.seed("workflows/wf2", {
      name: "On install", subAccountId: "sa1", agencyId: "ag1", status: "active",
      startNodeId: "m1", createdByUid: "u_owner",
      trigger: {
        type: "pipeline.stage.changed", pipelineId: "p2", toStage: "installed",
        filters: { all: [] },
      },
      nodes: { m1: { id: "m1", type: "goal", next: null, config: {} } },
    });
    seedRun({ stage: "installed", pipelineId: "p2" }, { workflowDepth: 2 });

    await runStep("run1", "n1");
    await flush();

    const enrolled = mem.list("workflowRuns").filter((r) => r.workflowId === "wf2");
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0].context).toMatchObject({
      dealId: "d1", pipelineId: "p2", fromStage: "booked", toStage: "installed",
      workflowDepth: 3,
    });
  });

  it("the move appends a stage-history row attributed to the workflow; an unchanged deal adds none", async () => {
    seedDeal("d1", { pipelineId: "p2", stageId: "booked" });
    seedRun({ stage: "installed", pipelineId: "p2" });
    await runStep("run1", "n1");
    await flush();
    expect(mem.list("dealStageHistory")).toEqual([
      expect.objectContaining({
        dealId: "d1", pipelineId: "p2", fromStageId: "booked", stageId: "installed",
        source: "workflow", createdByUid: "u_owner", subAccountId: "sa1", agencyId: "ag1",
      }),
    ]);
    seedRun({ stage: "installed", pipelineId: "p2" });
    await runStep("run1", "n1");
    await flush();
    expect(mem.list("dealStageHistory")).toHaveLength(1);
  });

  it("a legacy deal with no pipelineId counts as the default pipeline's", async () => {
    seedDeal("legacy", { stageId: "new" });
    seedRun({ stage: "qualified", pipelineId: "default" });
    await runStep("run1", "n1");
    await flush();
    expect(stageOf("legacy")).toBe("qualified");
    expect(stepLog()).toBe("stage:qualified;deal:moved:legacy");
  });

  it("skips deals already won or lost", async () => {
    seedDeal("won", { pipelineId: "p2", stageId: "done", updatedAt: at("2026-09-12") });
    seedDeal("lost", { pipelineId: "p2", stageId: "dropped", updatedAt: at("2026-09-12") });
    seedDeal("open", { pipelineId: "p2", stageId: "booked", updatedAt: at("2026-09-01") });
    seedRun({ stage: "installed", pipelineId: "p2" });
    await runStep("run1", "n1");
    await flush();
    expect(stageOf("won")).toBe("done");
    expect(stageOf("lost")).toBe("dropped");
    expect(stageOf("open")).toBe("installed");
    // Drain the move's webhooks so they cannot land in the next test.
    await vi.waitFor(() => expect(webhooks).toHaveLength(2));
  });

  it("only won/lost deals ⇒ no deal moves, contact still written", async () => {
    seedDeal("won", { pipelineId: "p2", stageId: "done" });
    seedRun({ stage: "installed", pipelineId: "p2" });
    await runStep("run1", "n1");
    await flush();
    expect(stageOf("won")).toBe("done");
    expect(mem.read("contacts/c1")?.pipelineStage).toBe("installed");
    expect(stepLog()).toBe("stage:installed;deal:skipped:no_open_deal");
    expect(webhooks).toEqual([]);
  });

  it("a stage that is not on the chosen pipeline moves no deal", async () => {
    seedDeal("d1", { pipelineId: "p2", stageId: "booked" });
    seedRun({ stage: "qualified", pipelineId: "p2" });
    await runStep("run1", "n1");
    await flush();
    expect(stageOf("d1")).toBe("booked");
    expect(mem.read("contacts/c1")?.pipelineStage).toBe("qualified");
    expect(stepLog()).toBe("stage:qualified;deal:skipped:stage_not_in_pipeline");
    expect(webhooks).toEqual([]);
  });

  it("no pipeline chosen ⇒ contact only, as before", async () => {
    seedDeal("d1", { stageId: "new" });
    seedRun({ stage: "qualified" });
    await runStep("run1", "n1");
    await flush();
    expect(stageOf("d1")).toBe("new");
    expect(mem.read("contacts/c1")?.pipelineStage).toBe("qualified");
    expect(stepLog()).toBe("stage:qualified");
    expect(webhooks).toEqual([]);
  });

  it("a deal already in the stage is left alone — nothing fires, so a workflow cannot re-trigger itself", async () => {
    seedDeal("d1", { pipelineId: "p2", stageId: "installed" });
    seedRun({ stage: "installed", pipelineId: "p2" });
    await runStep("run1", "n1");
    await flush();
    expect(stepLog()).toBe("stage:installed;deal:unchanged:d1");
    expect(webhooks).toEqual([]);
  });

  it("past the hop cap a chained run leaves the deal alone", async () => {
    seedDeal("d1", { pipelineId: "p2", stageId: "booked" });
    seedRun({ stage: "installed", pipelineId: "p2" }, { workflowDepth: 5 });
    await runStep("run1", "n1");
    await flush();
    expect(stageOf("d1")).toBe("booked");
    expect(mem.read("contacts/c1")?.pipelineStage).toBe("installed");
    expect(stepLog()).toBe("stage:installed;deal:skipped:loop_guard");
    expect(webhooks).toEqual([]);
  });

  it("two workflows moving the deal back and forth stop at the cap", async () => {
    // Drive the real chain: each pipeline.stage.changed enrols the other
    // workflow, whose step is run by hand in place of QStash.
    seedDeal("d1", { pipelineId: "p2", stageId: "booked" });
    const pingPong = (id: string, toStage: string, moveTo: string) =>
      mem.seed(`workflows/${id}`, {
        name: id, subAccountId: "sa1", agencyId: "ag1", status: "active",
        startNodeId: "s", createdByUid: "u_owner",
        trigger: { type: "pipeline.stage.changed", pipelineId: "p2", toStage, filters: { all: [] } },
        nodes: { s: { id: "s", type: "move_stage", next: null, config: { stage: moveTo, pipelineId: "p2" } } },
      });
    pingPong("toInstalled", "booked", "installed");
    pingPong("toBooked", "installed", "booked");
    seedRun({ stage: "installed", pipelineId: "p2" });

    await runStep("run1", "n1");
    await flush();
    const ran = new Set(["run1"]);
    for (let i = 0; i < 20; i++) {
      const next = mem.list("workflowRuns").find((r) => !ran.has(r.id));
      if (!next) break;
      ran.add(next.id);
      await runStep(next.id, "s");
      await flush();
    }
    const moves = () => webhooks.filter((w) => w.type === "deal.stage.changed");
    // run1 (depth 0) and the chained runs at depth 1–4 each move; the run
    // at depth 5 is enrolled but refuses, which ends the chain.
    await vi.waitFor(() => expect(moves()).toHaveLength(5));
    expect(mem.list("workflowRuns")).toHaveLength(6);
  });
});

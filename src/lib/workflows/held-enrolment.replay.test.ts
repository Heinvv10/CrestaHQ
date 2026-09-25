import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { proposals, runs, seedWorkflow, setupHeldEnrolmentTests } from "@/test/held-enrolment-harness";

/**
 * Ruling Q, the approve side for deal triggers: replaying a held deal
 * enrolment re-checks that the deal is still where the trigger said (split
 * from held-enrolment.test.ts; same harness).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/held-enrolment-harness")).qstashMock());

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

setupAgentProposalTests();
setupHeldEnrolmentTests();

describe("replaying a held deal trigger re-checks the deal", () => {
  beforeEach(() => {
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ben", tags: [], customFields: {}, territoryId: "global" });
    mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", title: "Fibre 100", stageId: "proposal", contactId: "c1", value: 1, currency: "ZAR" });
  });
  const moveTo = (stage: string) =>
    dispatchAgentTool(auth, "move_deal_stage", { dealId: "d1", dealTitle: "Fibre 100", stage });

  it("the enrolment preview names the deal and its stage", async () => {
    seedWorkflow("wf1", { type: "deal.won" });
    await moveTo("won");
    const won = proposals().find((p) => (p.args as { type: string }).type === "deal.won")!;
    expect(won.preview).toEqual(expect.arrayContaining([
      { label: "Deal", value: "Fibre 100" },
      { label: "Stage", value: "won" },
    ]));
  });

  it("breaker repro: a held deal.won approved after the deal moved to lost → failed (trigger_mismatch), 0 runs", async () => {
    seedWorkflow("wf1", { type: "deal.won" });
    await moveTo("won");
    mem.seed("deals/d1", { ...mem.read("deals/d1"), stageId: "lost" });
    const won = proposals().find((p) => (p.args as { type: string }).type === "deal.won")!;
    const res = await decide(won.id, "approve");
    expect(res.status).toBe(422);
    expect(row(won.id)).toMatchObject({ status: "failed", error: expect.stringContaining("trigger_mismatch") });
    expect(runs()).toEqual([]);
  });

  it("a held stage change approved after the deal moved on to another stage → failed, 0 runs", async () => {
    seedWorkflow("wf1", { type: "pipeline.stage.changed" });
    await moveTo("qualified");
    mem.seed("deals/d1", { ...mem.read("deals/d1"), stageId: "contacted" });
    const [p] = proposals();
    expect((await decide(p!.id, "approve")).status).toBe(422);
    expect(row(p!.id)).toMatchObject({ status: "failed", error: expect.stringContaining("trigger_mismatch") });
    expect(runs()).toEqual([]);
  });

  it("a deal now in ANOTHER sub-account (same id) → failed, 0 runs", async () => {
    seedWorkflow("wf1", { type: "pipeline.stage.changed" });
    await moveTo("qualified");
    mem.seed("deals/d1", { ...mem.read("deals/d1"), subAccountId: "sa2" });
    const [p] = proposals();
    expect((await decide(p!.id, "approve")).status).toBe(422);
    expect(runs()).toEqual([]);
  });

  it("a held deal.created stays approvable after the deal was moved (speed-to-lead)", async () => {
    seedWorkflow("wf1", { type: "deal.created" });
    await dispatchAgentTool(auth, "create_deal", {
      title: "New lead deal", value: 10, currency: "ZAR", contactId: "c1", contactName: "Ben", stage: "new",
    });
    const [p] = proposals();
    const dealId = (p!.args as { context: { dealId: string } }).context.dealId;
    mem.seed(`deals/${dealId}`, { ...mem.read(`deals/${dealId}`), stageId: "qualified" });
    expect((await decide(p!.id, "approve")).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });

  it("a held deal.created whose deal was deleted → failed, 0 runs", async () => {
    seedWorkflow("wf1", { type: "deal.created" });
    await dispatchAgentTool(auth, "create_deal", {
      title: "New lead deal", value: 10, currency: "ZAR", contactId: "c1", contactName: "Ben", stage: "new",
    });
    const [p] = proposals();
    await mem.db.doc(`deals/${(p!.args as { context: { dealId: string } }).context.dealId}`).delete();
    expect((await decide(p!.id, "approve")).status).toBe(422);
    expect(runs()).toEqual([]);
  });

  it("a deal deleted since the proposal → failed, 0 runs", async () => {
    seedWorkflow("wf1", { type: "pipeline.stage.changed" });
    await moveTo("qualified");
    await mem.db.doc("deals/d1").delete();
    const [p] = proposals();
    expect((await decide(p!.id, "approve")).status).toBe(422);
    expect(runs()).toEqual([]);
  });

  it("a deal moved to another pipeline since the proposal → failed, 0 runs", async () => {
    seedWorkflow("wf1", { type: "pipeline.stage.changed" });
    await moveTo("qualified");
    mem.seed("deals/d1", { ...mem.read("deals/d1"), pipelineId: "p_other" });
    const [p] = proposals();
    expect((await decide(p!.id, "approve")).status).toBe(422);
    expect(runs()).toEqual([]);
  });

  it("a won deal whose stage lost its terminal flag → failed, 0 runs", async () => {
    seedWorkflow("wf1", { type: "deal.won" });
    await moveTo("won");
    // The deal still sits on stage "won", but its pipeline no longer calls it won.
    const { DEFAULT_PIPELINE_ID } = await import("@/types/deals");
    const path = `subAccounts/sa1/pipelines/${DEFAULT_PIPELINE_ID}`;
    const pipeline = mem.read(path)!;
    mem.seed(path, { ...pipeline, stages: (pipeline.stages as Array<Record<string, unknown>>).map((st) => ({ ...st, terminal: undefined })) });
    const won = proposals().find((p) => (p.args as { type: string }).type === "deal.won")!;
    expect((await decide(won.id, "approve")).status).toBe(422);
    expect(runs()).toEqual([]);
  });

  it("the deal still where the trigger said → approve enrols", async () => {
    seedWorkflow("wf1", { type: "deal.won" });
    await moveTo("won");
    const won = proposals().find((p) => (p.args as { type: string }).type === "deal.won")!;
    expect((await decide(won.id, "approve")).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });
});

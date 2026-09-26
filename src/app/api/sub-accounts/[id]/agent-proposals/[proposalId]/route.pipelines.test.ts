import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * The PR9b pipeline capabilities and list_workflow_runs through the real
 * dispatch and decide route: create / update write through the settings
 * routes' own writers (so a stage with deals can't be dropped), names and
 * labels are visible text, delete is approved, and every id stays inside
 * the sub-account.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const PATH = "subAccounts/sa1/pipelines/p1";
const P1 = {
  subAccountId: "sa1", agencyId: "ag1", name: "Installs", isDefault: false,
  stages: [{ id: "booked", label: "Booked", tone: "" }, { id: "done", label: "Done", tone: "", terminal: "won" }],
};
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
const deal = (stageId: string) =>
  mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", title: "D", pipelineId: "p1", stageId, contactId: "c1" });

beforeEach(() => mem.seed(PATH, P1));

describe("reads", () => {
  it("list_pipelines shows the default and this sub-account's pipelines with their stages", async () => {
    mem.seed("subAccounts/sa2/pipelines/p2", { ...P1, subAccountId: "sa2", name: "Theirs" });
    const r = await call("list_pipelines", {});
    expect(r).toMatchObject({ ok: true, resultText: expect.stringContaining("Installs — id: p1; stages: Booked (booked), Done (done, won)") });
    expect(JSON.stringify(r)).toContain("id: default (default)");
    expect(JSON.stringify(r)).not.toContain("Theirs");
  });

  it("get_pipeline shows every stage; another sub-account's id isn't found", async () => {
    expect(await call("get_pipeline", { pipelineId: "p1" })).toMatchObject({ resultText: expect.stringContaining('"terminal": "won"') });
    mem.seed("subAccounts/sa2/pipelines/p2", { ...P1, subAccountId: "sa2" });
    expect(await call("get_pipeline", { pipelineId: "p2" })).toMatchObject({ ok: false, message: "That pipeline isn't in this workspace." });
  });
});

describe("create / update", () => {
  it("create_pipeline writes it, stamped as the agent's", async () => {
    const r = await call("create_pipeline", { name: "Repairs", stages: [{ label: "Logged" }, { label: "Fixed", terminal: "won" }] });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`subAccounts/sa1/pipelines/${id}`)).toMatchObject({
      name: "Repairs", isDefault: false, lastAgentEditKey: "abcd1234",
      stages: [{ id: "logged", label: "Logged" }, { id: "fixed", label: "Fixed", terminal: "won" }],
    });
  });

  it.each([
    ["an invisible character in the name", { name: "Re\u200bpairs", stages: [{ label: "A" }] }, "the name contains characters"],
    ["an invisible character in a stage label", { name: "Repairs", stages: [{ label: "Wo\u200bn" }] }, 'the stage label for "wo_n" contains characters'],
    ["a look-alike stage id", { name: "Repairs", stages: [{ id: "won\u200b", label: "Won" }] }, "must be a lowercase slug"],
    ["two Won stages", { name: "Repairs", stages: [{ label: "A", terminal: "won" }, { label: "B", terminal: "won" }] }, "one Won stage"],
    ["no stages", { name: "Repairs", stages: [] }, "at least one stage"],
  ])("create_pipeline with %s → refused", async (_label, args, message) => {
    expect(await call("create_pipeline", args)).toMatchObject({ ok: false, code: "invalid_args", message: expect.stringContaining(message) });
    expect(mem.list("subAccounts/sa1/pipelines")).toHaveLength(1);
  });

  it("update_pipeline renames and replaces the stages, stamped", async () => {
    const stages = [{ id: "booked", label: "Booked in" }, { id: "done", label: "Done", terminal: "won" }, { label: "Lost", terminal: "lost" }];
    expect(await call("update_pipeline", { pipelineId: "p1", name: "Installs 2", stages })).toMatchObject({ ok: true });
    expect(mem.read(PATH)).toMatchObject({ name: "Installs 2", lastAgentEditKey: "abcd1234", stages: [{ label: "Booked in" }, { id: "done" }, { id: "lost", terminal: "lost" }] });
  });

  it("update_pipeline dropping a stage that still has deals → refused, nothing written", async () => {
    deal("booked");
    expect(await call("update_pipeline", { pipelineId: "p1", stages: [{ id: "done", label: "Done", terminal: "won" }] })).toMatchObject({
      ok: false, message: '"Booked" still has 1 deal. Move them first.',
    });
    expect(mem.read(PATH)).toEqual(P1);
  });

  it("update_pipeline with an invisible label → refused; with nothing to change → refused", async () => {
    expect(await call("update_pipeline", { pipelineId: "p1", stages: [{ id: "booked", label: "Boo\u200bked" }] })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call("update_pipeline", { pipelineId: "p1" })).toMatchObject({ ok: false, code: "invalid_args", message: "give a name or stages" });
    expect(mem.read(PATH)).toEqual(P1);
  });
});

describe("delete_pipeline", () => {
  it("→ a proposal showing the pipeline (with a warning after an agent rename); approve deletes", async () => {
    await call("update_pipeline", { pipelineId: "p1", name: "Old installs" });
    const r = await call("delete_pipeline", { pipelineId: "p1" });
    if (!("proposal" in r)) throw new Error(JSON.stringify(r));
    const id = r.proposal.id;
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "Delete pipeline", value: "Old installs" },
      { label: "Stages", value: "Booked (booked), Done (done, won)" },
      { label: "Deals in it", value: "0" },
      { label: "Warning", value: expect.stringContaining("Last edited by API agent abcd1234") },
    ]));
    expect(mem.read(PATH)).toBeDefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read(PATH)).toBeUndefined();
  });

  it("with deals in it: the preview says it will fail, and approving fails, nothing deleted", async () => {
    deal("booked");
    const r = await call("delete_pipeline", { pipelineId: "p1" });
    if (!("proposal" in r)) throw new Error(JSON.stringify(r));
    expect(row(r.proposal.id).preview).toContainEqual({ label: "Will fail", value: "Deals are still in this pipeline; move or delete them first." });
    expect((await decide(r.proposal.id, "approve")).status).toBe(422);
    expect(row(r.proposal.id).error).toBe("This pipeline still has 1 deal. Move or delete them first.");
    expect(mem.read(PATH)).toBeDefined();
  });

  it("the default pipeline → refused at propose", async () => {
    expect(await call("delete_pipeline", { pipelineId: "default" })).toMatchObject({ ok: false, message: "The default pipeline can't be deleted." });
    expect(mem.list("agentProposals")).toEqual([]);
  });
});

it.each([
  ["get_pipeline", {}],
  ["update_pipeline", { name: "X" }],
  ["delete_pipeline", {}],
])("%s with an id that is a path → invalid args", async (name, args) => {
  expect(await call(name, { pipelineId: "p1/sub/y", ...args })).toMatchObject({ ok: false, code: "invalid_args" });
  expect(await call("list_workflow_runs", { workflowId: "wf1/sub/y" })).toMatchObject({ ok: false, code: "invalid_args" });
});

describe("list_workflow_runs", () => {
  it("lists this workflow's runs; another sub-account's workflow isn't found", async () => {
    mem.seed("workflows/wf1", { subAccountId: "sa1", agencyId: "ag1", name: "W", status: "active", nodes: {}, startNodeId: null, trigger: { type: "contact.created", filters: { all: [] } } });
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
    mem.seed("workflowRuns/r1", {
      id: "r1", workflowId: "wf1", subAccountId: "sa1", contactId: "c1", status: "waiting", context: { test: true },
      enrolledAt: Timestamp.fromDate(new Date("2030-01-10T08:00:00Z")),
      history: [{ nodeId: "n1", type: "send_sms", result: "ok", at: Timestamp.fromDate(new Date("2030-01-10T08:00:01Z")) }],
    });
    expect(await call("list_workflow_runs", { workflowId: "wf1" })).toMatchObject({
      resultText: "Runs (most recent 1):\n- run r1 — contact: Ann (c1), status: waiting (test), started: 2030-01-10T08:00:00.000Z, last step: send_sms (ok)",
    });
    mem.seed("workflows/wf2", { subAccountId: "sa2", agencyId: "ag1", name: "Theirs", status: "active", nodes: {} });
    expect(await call("list_workflow_runs", { workflowId: "wf2" })).toMatchObject({ ok: false, message: "That workflow isn't in this workspace." });
  });
});

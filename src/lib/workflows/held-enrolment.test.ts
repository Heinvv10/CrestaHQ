import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auth, decide, mem, row, setupAgentProposalTests,
} from "@/test/agent-proposals-harness";

/**
 * Ruling Q end to end: an API agent's write that would enrol a contact in an
 * ACTIVE workflow holds the enrolment as a `workflow_enrolment` proposal
 * instead; approving it replays the trigger for that one workflow, charging
 * the key's hourly enrolment cap. Real dispatch, engine, services, queue and
 * decide route over the in-memory Firestore; only QStash is stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { agentHold } = await import("./agent-hold");

setupAgentProposalTests();

function seedWorkflow(id: string, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mem.seed(`workflows/${id}`, {
    name: `Workflow ${id}`, subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner", trigger: { filters: { all: [] }, ...trigger },
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null } },
    ...extra,
  });
}
const runs = () => mem.list("workflowRuns");
const proposals = () => mem.list("agentProposals");
const createContact = () => dispatchAgentTool(auth, "create_contact", { name: "Ann Agent", email: "ann@x.io" });

beforeEach(() => {
  seedWorkflow("wf1", { type: "contact.created" });
});

describe("held-enrolment: agent create_contact with a matching ACTIVE workflow", () => {
  it("creates the contact, starts 0 runs and writes 1 workflow_enrolment proposal", async () => {
    const r = await createContact();
    expect(r).toMatchObject({ ok: true, held: [{ workflowName: "Workflow wf1" }] });
    const [contact] = mem.list("contacts");
    expect(contact).toMatchObject({ name: "Ann Agent" });
    expect(runs()).toEqual([]);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      approval: "workflow_enrolment",
      capability: "create_contact",
      workflowId: "wf1",
      contactId: contact!.id,
      targetScoped: true,
      territoryId: "global",
      pinned: { workflowId: "wf1", contactId: contact!.id },
      args: { type: "contact.created", contactId: contact!.id, context: {} },
      status: "pending",
    });
  });

  it("approve → exactly 1 run, of that workflow, charged to the key's hourly cap", async () => {
    await createContact();
    const [p] = proposals();
    expect((await decide(p!.id, "approve")).status).toBe(200);
    expect(runs()).toEqual([expect.objectContaining({ workflowId: "wf1", status: "running" })]);
    expect(row(p!.id)).toMatchObject({ status: "executed" });
    const [bucket] = mem.list("subAccounts/sa1/apiEnrolments");
    expect(bucket).toMatchObject({ keyId: "key1", count: 1 });
  });

  it("MUTATION PROOF: with the hold stubbed to fall through, the same write starts a run", async () => {
    vi.spyOn(agentHold, "shouldHold").mockReturnValue(false);
    await createContact();
    expect(runs()).toHaveLength(1);
    expect(proposals()).toEqual([]);
  });

  it("two matching workflows → two proposals; approving one enrols only that workflow (onlyWorkflowId)", async () => {
    seedWorkflow("wf2", { type: "contact.created" });
    const r = await createContact();
    expect((r as { held: unknown[] }).held).toHaveLength(2);
    const target = proposals().find((p) => p.workflowId === "wf2")!;
    await decide(target.id, "approve");
    expect(runs().map((x) => x.workflowId)).toEqual(["wf2"]);
  });

  it("a workflow paused since the proposal → approve fails, nobody enrolled, cap released", async () => {
    await createContact();
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), status: "paused" });
    const [p] = proposals();
    const res = await decide(p!.id, "approve");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("no longer active") });
    expect(runs()).toEqual([]);
    expect(mem.list("subAccounts/sa1/apiEnrolments")[0]).toMatchObject({ count: 0 });
  });

  it("a key at its hourly enrolment cap → approve fails, nobody enrolled", async () => {
    await createContact();
    const { enrolmentHourKey } = await import("@/lib/api/enrolment-cap");
    mem.seed(`subAccounts/sa1/apiEnrolments/key1_${enrolmentHourKey()}`, { keyId: "key1", count: 50 });
    const [p] = proposals();
    const res = await decide(p!.id, "approve");
    expect(await res.json()).toMatchObject({ status: "failed", error: expect.stringContaining("enrolments for this hour") });
    expect(runs()).toEqual([]);
  });

  it("a workflow whose re-entry policy already blocks the contact produces no proposal", async () => {
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), trigger: { type: "deal.created", filters: { all: [] } }, reentry: "once_ever" });
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ben", tags: [], customFields: {}, territoryId: "global" });
    mem.seed("workflowEnrolmentLocks/wf1_c1", { workflowId: "wf1", contactId: "c1", lastRunId: "r0" });
    const r = await dispatchAgentTool(auth, "create_deal", {
      title: "Fibre", value: 500, currency: "ZAR", contactId: "c1", contactName: "Ben", stage: "new",
    });
    expect(r).toMatchObject({ ok: true, held: [] });
    expect(proposals()).toEqual([]);
    expect(runs()).toEqual([]);
  });
});

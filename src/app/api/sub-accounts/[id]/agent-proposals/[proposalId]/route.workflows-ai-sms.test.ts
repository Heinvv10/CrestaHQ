import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedAiSmsReady } from "@/test/ai-outbound-sms-fixture";

/**
 * An agent activating, or editing an active, workflow with a "Send AI text"
 * step gets the same refusal as the builder's save when AI texts aren't
 * enabled and ready here: before a proposal is made (so the approver never
 * sees one that can't run), and again when an approved one executes.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/qstash")>()),
  qstashIsConfigured: () => true,
}));

await setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const AI_STEP = { n1: { id: "n1", type: "send_ai_sms", config: { instruction: "Offer a quote." }, next: null } };
const SMS_STEP = { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } };
const seedWf = (patch: Record<string, unknown> = {}) =>
  mem.seed("workflows/wf1", {
    id: "wf1", subAccountId: "sa1", agencyId: "ag1", name: "AI opener", status: "draft", startNodeId: "n1",
    trigger: { type: "contact.created", filters: { all: [] } }, nodes: AI_STEP, ...patch,
  });
const wf = () => mem.read("workflows/wf1")!;
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
const gateOff = () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  seedAiSmsReady(mem.seed, "sa1", mem.read("subAccounts/sa1"));
  seedWf();
});
afterEach(() => vi.unstubAllEnvs());

describe("set_workflow_status active", () => {
  it("is refused before any proposal while AI texts are off", async () => {
    gateOff();
    const r = await call("set_workflow_status", { workflowId: "wf1", status: "active" });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/switched off for this workspace/);
    expect(mem.list("agentProposals")).toEqual([]);
    expect(wf().status).toBe("draft");
  });

  it("an approval is refused at its re-check when AI texts went off after the proposal", async () => {
    const r = await call("set_workflow_status", { workflowId: "wf1", status: "active" });
    if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
    gateOff();
    const res = await decide(r.proposal.id, "approve");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message?: string }).message).toMatch(/switched off for this workspace/);
    expect(wf().status).toBe("draft");
  });

  it("an approved activation is refused at execute when AI texts go off after the re-check", async () => {
    const r = await call("set_workflow_status", { workflowId: "wf1", status: "active" });
    if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
    beforeNextTransaction(async () => gateOff());
    await decide(r.proposal.id, "approve");
    expect(row(r.proposal.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/switched off for this workspace/) });
    expect(wf().status).toBe("draft");
  });
});

describe("update_workflow on an active workflow", () => {
  it("adding a Send AI text step is refused before any proposal while AI texts are off", async () => {
    seedWf({ status: "active", nodes: SMS_STEP });
    gateOff();
    const r = await call("update_workflow", { workflowId: "wf1", nodes: AI_STEP });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/switched off for this workspace/);
    expect(mem.list("agentProposals")).toEqual([]);
    expect(wf().nodes).toEqual(SMS_STEP);
  });

  it("an approved edit adding the step is refused at execute when AI texts go off after the re-check", async () => {
    seedWf({ status: "active", nodes: SMS_STEP });
    const r = await call("update_workflow", { workflowId: "wf1", nodes: AI_STEP });
    if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
    beforeNextTransaction(async () => gateOff());
    await decide(r.proposal.id, "approve");
    expect(row(r.proposal.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/switched off for this workspace/) });
    expect(wf().nodes).toEqual(SMS_STEP);
  });

  it("a draft workflow may still get the step", async () => {
    gateOff();
    expect(await call("update_workflow", { workflowId: "wf1", nodes: AI_STEP })).toMatchObject({ ok: true });
  });
});

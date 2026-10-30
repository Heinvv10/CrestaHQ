import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { AI_LINE, AI_TEMPLATE, aiSmsText, seedAiSmsReady, stubOpenRouter } from "@/test/ai-outbound-sms-fixture";

/**
 * The J1 breakers' repros, kept as regressions against the template + slot
 * design: whatever route or opt-out the model writes never goes out; state
 * that changes while the AI writes stops the send; concurrent deliveries,
 * runs and workflows text once. Real runStep, readiness and
 * writing over a stubbed OpenRouter; the carrier seam is a spy.
 */

const mem = createMemoryFirestore();
const publishCallback = vi.fn();
const smsSent = vi.fn(async (_subAccountId: string, _args: { to: string; body: string }) => ({ sid: "SMai1" }));
let controls = { botMode: "auto", botPausedUntilMs: null as number | null, loopResetAtMs: null };

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
  getConversationControls: async () => controls,
  setConversationDraft: async () => undefined,
}));
vi.mock("@/lib/comms/sms/select", () => ({
  sendSmsVia: (subAccountId: string, args: { to: string; body: string }) => smsSent(subAccountId, args),
}));

const { enrollForTest, runStep } = await import("./engine");

const DAY = new Date("2026-09-25T10:00:00Z");
let aiReply = () => AI_LINE;
let ai: ReturnType<typeof stubOpenRouter>;

function seedWorkflow(config: Record<string, unknown> = {}, id = "wf1") {
  mem.seed(`workflows/${id}`, {
    name: "AI opener", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.created", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "send_ai_sms", next: null, config: {
      instruction: "A friendly line about fibre in their area.", template: AI_TEMPLATE, ...config,
    } } },
  });
}

async function runFirst(): Promise<string> {
  const before = new Set(mem.list("workflowRuns").map((r) => r.id));
  await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
  const runId = mem.list("workflowRuns").find((r) => !before.has(r.id))!.id;
  await runStep(runId, "n1");
  return runId;
}

const history = (runId: string) => mem.read(`workflowRuns/${runId}`)?.history as Array<{ result: string }>;
const sentBodies = () => smsSent.mock.calls.map((c) => c[1].body);
const runIdNow = () => mem.list("workflowRuns")[0].id;

beforeEach(() => {
  mem.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  smsSent.mockClear();
  controls = { botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null };
  aiReply = () => AI_LINE;
  ai = stubOpenRouter(() => aiReply());
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  seedAiSmsReady(mem.seed, "sa1");
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  seedWorkflow();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("A: a route or opt-out the model writes never goes out", () => {
  it.each([
    "Call oh eight two double one two three four now?",
    "Call 0800 FIBRE for a quote?",
    "Call 082 123 and then 4567 today?",
    "Find us on Facebook: VelocityDealsZA for a quote?",
    "DM us on Instagram - velocity_deals_za for a quote?",
    "Search VelocityDealsZA on WhatsApp for a quote?",
    "Visit evil point com for a quote?",
    "Visit evil d o t com for a quote?",
    "Email help AT evil DAWT com for a quote?",
    "Go to http://2130706433 for a quote?",
    "Text YES to 38383 for a quote?",
    "Ask for Mr Mokoena at the Sandton kiosk on level 2",
    "Want a quote? Reply END to quit.",
    "Text NO to cancel these messages.",
    "Reply S T O P to opt out.",
    "Reply STOP-ALL",
  ])("%s", async (line) => {
    aiReply = () => line;
    await runFirst();
    // Both tries refused: the operator's template goes without the line.
    expect(sentBodies()).toEqual([aiSmsText(null)]);
  });
});

describe("B: a change while the AI writes stops the send", () => {
  it.each<[string, () => void, string]>([
    ["automations paused", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), automationsPaused: true }), "skipped:automations_paused"],
    ["the run exited", () => mem.seed(`workflowRuns/${runIdNow()}`, { ...mem.read(`workflowRuns/${runIdNow()}`), status: "exited" }), "skipped:run_ended"],
    ["the phone changed", () => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), phone: "+27829999999" }), "skipped:phone_changed"],
    ["the instruction was edited", () => seedWorkflow({ instruction: "Totally different goal." }), "skipped:workflow_changed"],
    ["the template was edited", () => seedWorkflow({ template: "{{ai}} Different message." }), "skipped:workflow_changed"],
    ["sending without the line was switched off", () => seedWorkflow({ sendWithoutAiLine: false }), "skipped:workflow_changed"],
    ["the workflow was paused", () => mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), status: "paused" }), "skipped:workflow_changed"],
    ["SMS consent was declined", () => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsConsent: { consented: false } }), "skipped:opt_out"],
    ["the contact opted out", () => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true }), "skipped:opt_out"],
    ["AI texts were switched off", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false }), "skipped:ai_sms_gate_off"],
    ["a person took over", () => (controls = { ...controls, botPausedUntilMs: DAY.getTime() + 3600_000 }), "skipped:bot_paused"],
  ])("%s", async (_label, change, reason) => {
    aiReply = () => {
      change();
      return AI_LINE;
    };
    const runId = await runFirst();
    expect(smsSent).not.toHaveBeenCalled();
    expect(history(runId)?.[0]?.result).toBe(`${reason}:after_generation`);
  });
});

describe("C: concurrency", () => {
  it("two concurrent deliveries of one step text once and pay once", async () => {
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    await Promise.allSettled([runStep(runIdNow(), "n1"), runStep(runIdNow(), "n1")]);
    expect(smsSent.mock.calls.length).toBeLessThanOrEqual(1);
    expect(ai.fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("two workflows reaching one contact at once text it once (the cooldown)", async () => {
    seedWorkflow({}, "wf2");
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf2", contactId: "c1" });
    await Promise.allSettled(mem.list("workflowRuns").map((r) => runStep(r.id, "n1")));
    expect(smsSent).toHaveBeenCalledOnce();
  });

  it("two runs of one workflow on a prospect: one sends, the other's model fails, the stamp survives", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), source: "prospecting", prospecting: { listId: "l1", approachedAt: null } });
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    let calls = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    ai.fetchMock.mockImplementation(async () => {
      if (++calls === 1) {
        await gate;
        return { ok: true, status: 200, json: async () => ({ model: "m", choices: [{ message: { content: AI_LINE } }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }) };
      }
      open();
      throw new Error("timeout");
    });
    await Promise.allSettled(mem.list("workflowRuns").map((r) => runStep(r.id, "n1")));
    expect(smsSent).toHaveBeenCalledOnce();
    expect((mem.read("contacts/c1")?.prospecting as Record<string, unknown>).approachedAt).toBeTruthy();
  });

  it("an AI call that times out is recorded, its claim released, and nothing is sent", async () => {
    ai.fetchMock.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });
    const runId = await runFirst();
    expect(smsSent).not.toHaveBeenCalled();
    expect(history(runId)).toMatchObject([{ result: expect.stringMatching(/^error:ai_failed:/) }]);
    expect(mem.read(`workflowRuns/${runId}`)?.stepClaim ?? null).toBeNull();
  });
});

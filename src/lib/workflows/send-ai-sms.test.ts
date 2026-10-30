import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { AI_LINE, AI_TEMPLATE, aiSmsText, seedAiSmsReady, stubOpenRouter } from "@/test/ai-outbound-sms-fixture";

/**
 * The "Send AI text" step through the REAL runStep: real readiness, real
 * opener generation over a stubbed OpenRouter, the real
 * `sendSmsForSubAccount` (quiet hours, quota, dedicated number, usage meter)
 * down to the carrier seam, which is a spy, so nothing is sent. 10:00Z =
 * 12:00 SAST, inside the workspace's 08:00–20:00 send window.
 */

const mem = createMemoryFirestore();
const publishCallback = vi.fn();
const smsSent = vi.fn(async (_subAccountId: string, _args: { to: string; body: string }) => ({ sid: "SMai1" }));
const setConversationDraft = vi.fn(async () => undefined);
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
  setConversationDraft: (...a: unknown[]) => setConversationDraft(...(a as [])),
}));
vi.mock("@/lib/comms/sms/select", () => ({
  sendSmsVia: (subAccountId: string, args: { to: string; body: string }) => smsSent(subAccountId, args),
}));

const { enrollForTest, runStep } = await import("./engine");
const { flushAfterResponse } = await import("@/lib/server/after-response");
const { usageMonthKey } = await import("@/lib/server/usage-meter");
const { APPROACH_REFUSED_LOG } = await import("@/lib/prospecting/approach-guard");

const DAY = new Date("2026-09-25T10:00:00Z");
const NIGHT = new Date("2026-09-25T19:30:00Z"); // 21:30 SAST
const OPENER = AI_LINE;
let aiReply = () => OPENER;
let ai: ReturnType<typeof stubOpenRouter>;

function seedWorkflow(instruction = "A friendly line about fibre in their area.", extra: Record<string, unknown> = {}) {
  mem.seed("workflows/wf1", {
    name: "AI opener", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.created", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "send_ai_sms", config: { instruction, template: AI_TEMPLATE, ...extra }, next: null } },
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

beforeEach(() => {
  mem.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  smsSent.mockClear();
  setConversationDraft.mockClear();
  controls = { botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null };
  aiReply = () => OPENER;
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

describe("Send AI text", () => {
  it("writes the opener and sends it from the workspace's own number, with the opt-out line", async () => {
    const runId = await runFirst();
    expect(sentBodies()).toEqual([aiSmsText()]);
    expect(smsSent.mock.calls[0][0]).toBe("sa1");
    expect(history(runId)).toMatchObject([{ result: "ok" }]);
    const activity = mem.list("contacts/c1/activities").find((a) => a.type === "sms_sent");
    expect(activity?.content).toMatch(/^AI text \(workflow\): /);
    expect(activity?.meta).toMatchObject({ mode: "dedicated" });
  });

  it("meters the text's SMS segments and the AI tokens", async () => {
    await runFirst();
    await flushAfterResponse();
    const usage = mem.read(`subAccounts/sa1/usage/${usageMonthKey()}`);
    expect(usage?.smsSegments).toBe(1);
    expect(usage?.aiTokens).toBe(120);
  });

  it("skips an SMS opt-out without calling the AI", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "skipped:opt_out" }]);
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(smsSent).not.toHaveBeenCalled();
  });

  it("skips a declined SMS consent too", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsConsent: { consented: false } });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "skipped:opt_out" }]);
    expect(smsSent).not.toHaveBeenCalled();
  });

  it("still sends to a contact who opted out of WhatsApp only", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), whatsappOptedOut: true });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "ok" }]);
    expect(smsSent).toHaveBeenCalledOnce();
  });

  it("skips with a reason when the agency gate is off — re-checked at send time", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "skipped:ai_sms_gate_off" }]);
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(smsSent).not.toHaveBeenCalled();
  });

  it.each([
    ["the SMS agent was switched off", () => mem.seed("subAccounts/sa1/aiAgent/sms", { ...mem.read("subAccounts/sa1/aiAgent/sms"), enabled: false }), "sms_agent_on"],
    ["the Twilio token is gone (marker only)", () => mem.seed("subAccounts/sa1/private/twilioCredentials", {}), "twilio"],
    ["the SMS AI gate was switched off", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), smsAgentEnabledByAgency: false }), "sms_agent_gate"],
  ])("skips as not ready when %s", async (_label, breakIt, key) => {
    breakIt();
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: `skipped:not_ready:${key}` }]);
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(smsSent).not.toHaveBeenCalled();
  });

  it("holds in quiet hours without calling the AI, and reschedules the same step", async () => {
    vi.setSystemTime(NIGHT);
    const runId = await runFirst();
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(smsSent).not.toHaveBeenCalled();
    expect(history(runId)).toEqual([]);
    const p = publishCallback.mock.calls.at(-1)![0] as { body: { nodeId: string }; delaySeconds: number };
    expect(p.body.nodeId).toBe("n1");
    expect(p.delaySeconds).toBeGreaterThan(10 * 3600);
  });

  it("holds when quiet hours begin while the AI is writing: the send itself is automated", async () => {
    aiReply = () => {
      vi.setSystemTime(NIGHT);
      return OPENER;
    };
    const runId = await runFirst();
    expect(ai.fetchMock).toHaveBeenCalledOnce();
    expect(smsSent).not.toHaveBeenCalled();
    expect(history(runId)).toEqual([]);
  });

  it("never texts twice: a delivery that finds the step claimed but unrecorded sends nothing", async () => {
    await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
    const runId = mem.list("workflowRuns")[0].id;
    await mem.db.doc(`workflowRuns/${runId}`).update({ stepClaim: { nodeId: "n1", state: "sending", at: new Date() } });
    await expect(runStep(runId, "n1")).rejects.toThrow(/already claimed/);
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(smsSent).not.toHaveBeenCalled();
  });

  it("a redelivery after the text went out sends nothing more", async () => {
    const runId = await runFirst();
    await runStep(runId, "n1");
    expect(smsSent).toHaveBeenCalledOnce();
    expect(ai.fetchMock).toHaveBeenCalledOnce();
  });

  it("a line that breaks the rules twice: the template goes without it, both tries metered", async () => {
    let n = 0;
    aiReply = () => (n++ === 0 ? "Claim your deal at velo-deals.example.com/win" : "Call oh eight two double one two three four");
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "ok:without_ai_line" }]);
    expect(sentBodies()).toEqual([aiSmsText(null)]);
    expect(ai.fetchMock).toHaveBeenCalledTimes(2);
    await flushAfterResponse();
    expect(mem.read(`subAccounts/sa1/usage/${usageMonthKey()}`)?.aiTokens).toBe(240);
  });

  it("with sending without the line switched off, nothing goes out", async () => {
    seedWorkflow(undefined, { sendWithoutAiLine: false });
    aiReply = () => "Search VelocityDealsZA on WhatsApp";
    const runId = await runFirst();
    expect(history(runId)[0].result).toMatch(/^error:ai_failed:slot_invalid:/);
    expect(smsSent).not.toHaveBeenCalled();
  });

  it("the operator's own link and number in the template go out verbatim", async () => {
    mem.seed("workflows/wf1", {
      ...mem.read("workflows/wf1"),
      nodes: { n1: { id: "n1", type: "send_ai_sms", next: null, config: {
        instruction: "A friendly line.", template: "{{ai}} Book at https://velocityfibre.co.za/Book or call 082 123 4567.",
      } } },
    });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "ok" }]);
    expect(sentBodies()[0]).toBe(`${AI_LINE} Book at https://velocityfibre.co.za/Book or call 082 123 4567. Reply STOP to opt out.`);
  });

  it("a template without {{ai}} is refused before anything is spent", async () => {
    seedWorkflow(undefined, { template: "Hi {{firstName}}, want a quote?" });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "error:template_invalid" }]);
    expect(ai.fetchMock).not.toHaveBeenCalled();
  });

  it("saves a draft instead of sending when the conversation is on Suggest", async () => {
    controls = { ...controls, botMode: "suggest" };
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "drafted:suggest_mode" }]);
    expect(smsSent).not.toHaveBeenCalled();
    expect(setConversationDraft).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c1", channel: "sms", body: aiSmsText() }),
    );
  });

  it("skips a conversation a person has taken over", async () => {
    controls = { ...controls, botPausedUntilMs: DAY.getTime() + 3600_000 };
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: "skipped:bot_paused" }]);
    expect(ai.fetchMock).not.toHaveBeenCalled();
  });

  it("is refused by the prospecting approach guard like any send", async () => {
    mem.seed("contacts/c1", {
      ...mem.read("contacts/c1"), source: "prospecting",
      prospecting: { listId: "l1", approachedAt: new Date(DAY.getTime() - 86_400_000), approachedWorkflowId: "wf_other" },
    });
    const runId = await runFirst();
    expect(history(runId)).toMatchObject([{ result: APPROACH_REFUSED_LOG }]);
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(smsSent).not.toHaveBeenCalled();
  });
});

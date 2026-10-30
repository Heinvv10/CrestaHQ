import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { AI_LINE, AI_TEMPLATE, seedAiSmsReady, stubOpenRouter } from "@/test/ai-outbound-sms-fixture";

/**
 * Send AI text, second round: the prospecting stamp is taken only once the
 * step can send and handed back when it doesn't; the aiTokens quota stops it
 * before the model call; a failure after the tokens are spent is recorded,
 * never retried; and a contact gets at most one AI text per 30 days. Real
 * runStep on an in-memory Firestore; the carrier seam is a spy.
 */

const mem = createMemoryFirestore();
let failContactReadAfterAi = false;
let aiCalled = false;
/** Another run's AI text landing between this step's re-check and its claim. */
let cooldownTakenBeforeClaim = false;
const db = {
  ...mem.db,
  runTransaction: (fn: Parameters<typeof mem.db.runTransaction>[0]) => {
    if (cooldownTakenBeforeClaim && aiCalled) {
      cooldownTakenBeforeClaim = false;
      mem.seed("subAccounts/sa1/aiSmsCooldowns/c1", { lastSentAtMs: Date.now(), runId: "other_run", previousAtMs: null });
    }
    return mem.db.runTransaction(fn);
  },
  doc: (path: string) => {
    const ref = mem.db.doc(path);
    if (path !== "contacts/c1") return ref;
    return {
      ...ref,
      get: async () => {
        if (failContactReadAfterAi && aiCalled) throw new Error("14 UNAVAILABLE: simulated read failure");
        return ref.get();
      },
    };
  },
};
const publishCallback = vi.fn();
let controls = { botMode: "auto", botPausedUntilMs: null as number | null, loopResetAtMs: null };
const smsSent = vi.fn(async (_subAccountId: string, _args: { to: string; body: string }) => ({ sid: "SMai1" }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
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
const { usageMonthKey } = await import("@/lib/server/usage-meter");
const { AI_SMS_COOLDOWN_MS } = await import("./ai-sms-cooldown");
const { guardProspectSend } = await import("@/lib/prospecting/approach-guard");

const DAY = new Date("2026-09-25T10:00:00Z");
const OPENER = AI_LINE;
/** A line the slot rules refuse; with sending without the line off, a step
 *  that gets it twice produces nothing. */
const BAD_LINE = "Get a quote at evil.com today?";
let aiReply = () => OPENER;
let ai: ReturnType<typeof stubOpenRouter>;
const COUNTERS = "subAccounts/sa1/prospectingFirstTouch";
const counter = () => mem.list(COUNTERS).reduce((n, d) => n + ((d.count as number) ?? 0), 0);
const prospecting = () => mem.read("contacts/c1")?.prospecting as Record<string, unknown> | undefined;

async function runFirst(): Promise<string> {
  const before = new Set(mem.list("workflowRuns").map((r) => r.id));
  await enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });
  const runId = mem.list("workflowRuns").find((r) => !before.has(r.id))!.id;
  await runStep(runId, "n1");
  return runId;
}
const result = (runId: string) => (mem.read(`workflowRuns/${runId}`)?.history as Array<{ result: string }>)[0]?.result;

beforeEach(() => {
  mem.clear();
  failContactReadAfterAi = false;
  aiCalled = false;
  cooldownTakenBeforeClaim = false;
  controls = { botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  smsSent.mockClear();
  aiReply = () => OPENER;
  ai = stubOpenRouter(() => {
    aiCalled = true;
    return aiReply();
  });
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  seedAiSmsReady(mem.seed, "sa1");
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi", phone: "+27821234567",
    tags: ["prospecting"], customFields: {}, source: "prospecting", prospecting: { listId: "l1", approachedAt: null },
  });
  mem.seed("workflows/wf1", {
    name: "AI opener", subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "prospecting.report.ready", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "send_ai_sms", config: { instruction: "Offer a fibre quote.", template: AI_TEMPLATE, sendWithoutAiLine: false }, next: null } },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the prospecting stamp", () => {
  it("is taken and counted when the text goes out", async () => {
    await runFirst();
    expect(smsSent).toHaveBeenCalledOnce();
    expect(prospecting()?.approachedWorkflowId).toBe("wf1");
    expect(counter()).toBe(1);
  });

  it.each([
    ["the gate is off", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false })],
    ["the step is not ready", () => mem.seed("subAccounts/sa1/aiAgent/sms", { ...mem.read("subAccounts/sa1/aiAgent/sms"), enabled: false })],
  ])("is never taken when %s", async (_label, breakIt) => {
    breakIt();
    await runFirst();
    expect(prospecting()?.approachedAt ?? null).toBeNull();
    expect(counter()).toBe(0);
  });

  it("is never even looked at when the step can't send: the gate wins over another workflow's approach", async () => {
    mem.seed("contacts/c1", {
      ...mem.read("contacts/c1"),
      prospecting: { listId: "l1", approachedAt: new Date(DAY.getTime() - 86_400_000), approachedWorkflowId: "wf_other" },
    });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });
    expect(result(await runFirst())).toBe("skipped:ai_sms_gate_off");
  });

  it("is handed back, with its cap slot, when the AI's text is refused", async () => {
    aiReply = () => BAD_LINE;
    const runId = await runFirst();
    expect(result(runId)).toMatch(/^error:ai_failed:slot_invalid:/);
    expect(smsSent).not.toHaveBeenCalled();
    expect(prospecting()?.approachedAt ?? null).toBeNull();
    expect(prospecting()?.approachedWorkflowId).toBeUndefined();
    expect(counter()).toBe(0);
  });

  it("is handed back when AI texts are switched off while the AI writes", async () => {
    aiReply = () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });
      return OPENER;
    };
    const runId = await runFirst();
    expect(result(runId)).toBe("skipped:ai_sms_gate_off:after_generation");
    expect(prospecting()?.approachedAt ?? null).toBeNull();
    expect(counter()).toBe(0);
  });

  const kept: Array<[string, () => void, () => string, string | undefined]> = [
    ["the text was saved as a draft", () => (controls = { ...controls, botMode: "suggest" }), () => OPENER, "drafted:suggest_mode"],
    [
      "quiet hours held the text",
      () => undefined,
      () => {
        vi.setSystemTime(new Date("2026-09-25T19:30:00Z"));
        return OPENER;
      },
      undefined, // held: no history entry, the same step runs again
    ],
    [
      "the contact opted out while the AI wrote",
      () => undefined,
      () => {
        mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true });
        return OPENER;
      },
      "skipped:opt_out:after_generation",
    ],
  ];
  it.each(kept)("is kept when %s (not a nothing-produced outcome)", async (_label, setup, reply, expected) => {
    setup();
    aiReply = reply;
    const runId = await runFirst();
    expect(result(runId)).toBe(expected);
    expect(prospecting()).toMatchObject({ approachedWorkflowId: "wf1", approachedRunId: runId });
    expect(counter()).toBe(1);
  });

  it("is kept when the template went out without the AI line", async () => {
    const wf = mem.read("workflows/wf1")!;
    const n1 = (wf.nodes as Record<string, { config: Record<string, unknown> }>).n1;
    mem.seed("workflows/wf1", { ...wf, nodes: { n1: { ...n1, config: { ...n1.config, sendWithoutAiLine: true } } } });
    aiReply = () => BAD_LINE;
    const runId = await runFirst();
    expect(result(runId)).toBe("ok:without_ai_line");
    expect(prospecting()).toMatchObject({ approachedWorkflowId: "wf1", approachedRunId: runId });
    expect(counter()).toBe(1);
  });

  it("is handed back when the filled-in message is too long to send", async () => {
    const wf = mem.read("workflows/wf1")!;
    const n1 = (wf.nodes as Record<string, { config: Record<string, unknown> }>).n1;
    mem.seed("workflows/wf1", { ...wf, nodes: { n1: { ...n1, config: { ...n1.config, template: `${"{{business}} ".repeat(25)}{{ai}}` } } } });
    const runId = await runFirst();
    expect(result(runId)).toBe("error:ai_too_long");
    expect(prospecting()?.approachedAt ?? null).toBeNull();
    expect(counter()).toBe(0);
  });

  it("is not taken back once another run of the same workflow holds it", async () => {
    aiReply = () => {
      // Another run of wf1 passes the guard (and sends) while this one writes.
      mem.seed("contacts/c1", {
        ...mem.read("contacts/c1"),
        prospecting: { ...prospecting(), approachedRunId: "run_other", approachedNodeId: "n1" },
      });
      return BAD_LINE;
    };
    const runId = await runFirst();
    expect(result(runId)).toMatch(/^error:ai_failed:slot_invalid:/);
    expect(prospecting()).toMatchObject({ approachedWorkflowId: "wf1", approachedRunId: "run_other" });
    expect(prospecting()?.approachedAt).toBeTruthy();
    expect(counter()).toBe(1);
  });

  it("a later send of the same workflow takes the stamp over, so the first can't release it", async () => {
    const first = await runFirst();
    expect(prospecting()).toMatchObject({ approachedRunId: first, approachedNodeId: "n1" });
    const refusal = await guardProspectSend({
      contactId: "c1", subAccountId: "sa1", agencyId: "ag1", subAccount: null,
      workflowId: "wf1", runId: "run_later", nodeId: "n2",
    });
    expect(refusal).toBeNull();
    expect(prospecting()).toMatchObject({ approachedRunId: "run_later", approachedNodeId: "n2" });
    expect(counter()).toBe(1);
  });
});

describe("the aiTokens quota", () => {
  it("stops the step before the model is called", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), usageQuotas: { aiTokensPerMonth: 1000 } });
    mem.seed(`subAccounts/sa1/usage/${usageMonthKey()}`, { aiTokens: 1000 });
    const runId = await runFirst();
    expect(result(runId)).toBe("skipped:quota");
    expect(ai.fetchMock).not.toHaveBeenCalled();
    expect(prospecting()?.approachedAt ?? null).toBeNull();
  });
});

describe("a failure after the tokens are spent", () => {
  it("is recorded and stops the run; a redelivery never calls the model again", async () => {
    failContactReadAfterAi = true;
    const runId = await runFirst();
    expect(result(runId)).toMatch(/^error:ai_after_generation:14 UNAVAILABLE/);
    expect(mem.read(`workflowRuns/${runId}`)?.status).toBe("failed");
    await runStep(runId, "n1").catch(() => undefined);
    expect(ai.fetchMock).toHaveBeenCalledOnce();
    expect(smsSent).not.toHaveBeenCalled();
  });
});

describe("the 30-day cooldown", () => {
  const plainContact = () => mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi", phone: "+27821234567", tags: [], customFields: {},
  });

  it("texts a contact once; a second run within 30 days is skipped before the model call", async () => {
    plainContact();
    await runFirst();
    ai.fetchMock.mockClear();
    vi.setSystemTime(new Date(DAY.getTime() + AI_SMS_COOLDOWN_MS - 60_000));
    const second = await runFirst();
    expect(result(second)).toBe("skipped:ai_sms_cooldown");
    expect(smsSent).toHaveBeenCalledOnce();
    expect(ai.fetchMock).not.toHaveBeenCalled();
  });

  it("a claim lost to another run's text in the same moment sends nothing", async () => {
    plainContact();
    cooldownTakenBeforeClaim = true;
    const runId = await runFirst();
    expect(result(runId)).toBe("skipped:ai_sms_cooldown");
    expect(smsSent).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1/aiSmsCooldowns/c1")?.runId).toBe("other_run");
  });

  it("texts again once 30 days have passed", async () => {
    plainContact();
    await runFirst();
    vi.setSystemTime(new Date(DAY.getTime() + AI_SMS_COOLDOWN_MS + 60_000));
    const second = await runFirst();
    expect(result(second)).toBe("ok");
    expect(smsSent).toHaveBeenCalledTimes(2);
  });

  it("is handed back when nothing went out, so the next run can text", async () => {
    plainContact();
    aiReply = () => {
      vi.setSystemTime(new Date("2026-09-25T19:30:00Z")); // quiet hours begin while the AI writes
      return OPENER;
    };
    await runFirst();
    expect(smsSent).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1/aiSmsCooldowns/c1")).toBeUndefined();
  });

  it("is handed back when the carrier send fails before reaching the provider", async () => {
    plainContact();
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), usageQuotas: { smsSegmentsPerMonth: 5 } });
    const month = `subAccounts/sa1/usage/${usageMonthKey()}`;
    aiReply = () => {
      mem.seed(month, { smsSegments: 5 }); // the SMS quota fills while the AI writes
      return OPENER;
    };
    const runId = await runFirst();
    expect(result(runId)).toBe("skipped:quota");
    expect(mem.read("subAccounts/sa1/aiSmsCooldowns/c1")).toBeUndefined();
  });
});

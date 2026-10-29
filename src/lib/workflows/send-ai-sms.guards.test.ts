import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { seedAiSmsReady, stubOpenRouter } from "@/test/ai-outbound-sms-fixture";

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
const db = {
  ...mem.db,
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
const smsSent = vi.fn(async (_subAccountId: string, _args: { to: string; body: string }) => ({ sid: "SMai1" }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
  getConversationControls: async () => ({ botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null }),
  setConversationDraft: async () => undefined,
}));
vi.mock("@/lib/comms/sms/select", () => ({
  sendSmsVia: (subAccountId: string, args: { to: string; body: string }) => smsSent(subAccountId, args),
}));

const { enrollForTest, runStep } = await import("./engine");
const { usageMonthKey } = await import("@/lib/server/usage-meter");
const { AI_SMS_COOLDOWN_MS } = await import("./ai-sms-cooldown");

const DAY = new Date("2026-09-25T10:00:00Z");
const OPENER = "Hi Thandi, this is Velocity Fibre. Would you like a quick fibre quote for your street?";
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
    nodes: { n1: { id: "n1", type: "send_ai_sms", config: { instruction: "Offer a fibre quote." }, next: null } },
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

  it("is handed back, with its cap slot, when the AI's text is refused", async () => {
    aiReply = () => "Hi Thandi, Velocity Fibre here. Get a quote at evil.com today?";
    const runId = await runFirst();
    expect(result(runId)).toBe("error:ai_link_not_allowed");
    expect(smsSent).not.toHaveBeenCalled();
    expect(prospecting()?.approachedAt ?? null).toBeNull();
    expect(prospecting()?.approachedWorkflowId).toBeUndefined();
    expect(counter()).toBe(0);
  });

  it("is handed back when the contact opts out while the AI writes", async () => {
    aiReply = () => {
      mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true });
      return OPENER;
    };
    const runId = await runFirst();
    expect(result(runId)).toBe("skipped:opt_out:after_generation");
    expect(prospecting()?.approachedAt ?? null).toBeNull();
    expect(counter()).toBe(0);
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

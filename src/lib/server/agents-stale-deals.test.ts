import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { flushAfterResponse } from "@/lib/server/after-response";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The Stale deals monitor through the real hourly sweep, the real pipeline
 * reads, the real task writer and (for the re-arm) the real deal service's
 * stage move, over an in-memory Firestore. Faked: the AI note, push
 * delivery, webhooks and the workflow engine.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({
  aiConfigured: true,
  aiCalls: 0,
  pushes: [] as Array<{ tag?: string; territoryId?: string | null }>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/ai/openrouter", () => ({
  aiIsConfigured: () => t.aiConfigured,
  callAi: async () => {
    t.aiCalls++;
    return { text: "Call them about the revised quote.", totalTokens: 7 };
  },
}));
vi.mock("@/lib/comms/ai/agent", () => ({ getAgentProfile: async () => null }));
vi.mock("@/lib/push/send", () => ({
  sendPushForEvent: async (input: { tag?: string; territoryId?: string | null }) =>
    void t.pushes.push(input),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { runWatchdogSweep } = await import("./agents-watchdog-service");
const { updateDealServerSide } = await import("./deals-service");

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 10);

function seedDeal(id: string, fields: Record<string, unknown>) {
  mem.seed(`deals/${id}`, {
    subAccountId: "sa1",
    agencyId: "ag1",
    createdByUid: "u1",
    title: `Deal ${id}`,
    value: 100,
    currency: "ZAR",
    contactId: "c1",
    stageId: "proposal",
    priority: "medium",
    mode: "live",
    territoryId: "global",
    stageChangedAt: Timestamp.fromMillis(T0 - 10 * DAY),
    ...fields,
  });
}

const tasksFor = (dealId: string) =>
  mem.list("tasks").filter((task) => task.dealId === dealId);

function lastRun() {
  const runs = mem
    .all()
    .filter((d) => d.path.startsWith("customAgents/sa1_stale-deals/runs/"));
  return runs[runs.length - 1]?.data;
}

async function sweep() {
  const out = await runWatchdogSweep();
  await flushAfterResponse();
  return out;
}

beforeEach(() => {
  mem.clear();
  t.aiConfigured = true;
  t.aiCalls = 0;
  t.pushes = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ownerUid: "u1", name: "Acme", agentsEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", territoryId: "global" });
  mem.seed("customAgents/sa1_stale-deals", {
    subAccountId: "sa1",
    agencyId: "ag1",
    type: "stale-deals",
    enabled: true,
    thresholdDays: 7,
    pipelineIds: null,
    excludeStageKeys: [],
    dailyTokenBudget: 10_000,
    tokensToday: 0,
    tokensTodayDate: null,
    totalTokensUsed: 0,
  });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals",
    isDefault: false,
    agencyId: "ag1",
    subAccountId: "sa1",
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "renewed", label: "Renewed", tone: "", terminal: "won" },
      { id: "churned", label: "Churned", tone: "", terminal: "lost" },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stale deals sweep", () => {
  it("flags a stale open deal: task on the deal, push, activity, stamp", async () => {
    seedDeal("d1", {});
    const { results } = await sweep();

    expect(results).toEqual([expect.objectContaining({ type: "stale-deals", status: "completed", flagged: 1 })]);
    const [task] = tasksFor("d1");
    expect(task).toMatchObject({ createdByUid: "ai-monitor", contactId: "c1", mode: "live", completed: false });
    expect(task.notes).toContain("Suggested next step: Call them about the revised quote.");
    expect(t.pushes).toEqual([expect.objectContaining({ tag: "stale-deal-d1", territoryId: "global" })]);
    const acts = mem.list("contacts/c1/activities").filter((a) => a.type === "ai_agent_flagged");
    expect(acts).toEqual([expect.objectContaining({ meta: expect.objectContaining({ dealId: "d1", taskId: task.id }) })]);
    expect(mem.read("deals/d1")?.staleAlertedAt).toBeInstanceOf(Date);
    expect(lastRun()).toMatchObject({ status: "completed", flagged: 1, judged: 1, tokensUsed: 7 });
  });

  it("alerts once per stage visit, and a real stage move re-arms it", async () => {
    seedDeal("d1", {});
    await sweep();
    expect(tasksFor("d1")).toHaveLength(1);

    // Same visit, the task completed so "open task" can't be what holds it.
    for (const task of tasksFor("d1")) mem.seed(`tasks/${task.id}`, { ...task, completed: true });
    vi.setSystemTime(T0 + 2 * 3_600_000);
    await sweep();
    expect(tasksFor("d1")).toHaveLength(1);

    // A stage move through the deal service, then the deal sits past the
    // threshold again in its new stage: a new visit, a new alert.
    vi.setSystemTime(T0 + 3 * 3_600_000);
    const moved = await updateDealServerSide({
      dealId: "d1",
      userId: "u1",
      expectedSubAccountId: "sa1",
      source: "app",
      patch: { stageId: "qualified" },
    });
    expect(moved).not.toBeNull();
    await flushAfterResponse();
    vi.setSystemTime(T0 + 8 * DAY);
    await sweep();
    expect(tasksFor("d1")).toHaveLength(2);
  });

  it("two overlapping sweeps raise one alert", async () => {
    seedDeal("d1", {});
    await Promise.all([runWatchdogSweep(), runWatchdogSweep()]);
    await flushAfterResponse();
    expect(tasksFor("d1")).toHaveLength(1);
  });

  it("never flags a terminal stage of a custom pipeline (or of the default)", async () => {
    seedDeal("won-custom", { pipelineId: "p2", stageId: "renewed" });
    seedDeal("lost-custom", { pipelineId: "p2", stageId: "churned" });
    seedDeal("lost-default", { stageId: "lost" });
    seedDeal("open-custom", { pipelineId: "p2", stageId: "open" });
    await sweep();
    expect(tasksFor("won-custom")).toHaveLength(0);
    expect(tasksFor("lost-custom")).toHaveLength(0);
    expect(tasksFor("lost-default")).toHaveLength(0);
    expect(tasksFor("open-custom")).toHaveLength(1);
  });

  it("ignores test-mode deals; a deal with no mode is live", async () => {
    seedDeal("test-deal", { mode: "test" });
    seedDeal("no-mode", { mode: undefined });
    await sweep();
    expect(tasksFor("test-deal")).toHaveLength(0);
    expect(tasksFor("no-mode")).toHaveLength(1);
  });

  it("skips deals that are recent, have an open task, or a fresh message", async () => {
    seedDeal("fresh", { stageChangedAt: Timestamp.fromMillis(T0 - 2 * DAY) });
    seedDeal("tasked", { contactId: "c2" });
    mem.seed("contacts/c2", { subAccountId: "sa1", agencyId: "ag1", name: "Bo" });
    mem.seed("tasks/open1", { subAccountId: "sa1", dealId: "tasked", completed: false });
    seedDeal("talking", { contactId: "c3" });
    mem.seed("contacts/c3", { subAccountId: "sa1", agencyId: "ag1", name: "Cy" });
    mem.seed("conversations/c3", { subAccountId: "sa1", lastMessageAt: Timestamp.fromMillis(T0 - DAY) });
    await sweep();
    expect(tasksFor("fresh")).toHaveLength(0);
    expect(tasksFor("tasked")).toHaveLength(1); // only the seeded one
    expect(tasksFor("talking")).toHaveLength(0);
  });

  it("gate off: skipped with agents_gate_off, nothing written to the deal", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", agentsEnabledByAgency: false, labsEnabledByAgency: true, aiSuiteEnabledByAgency: true });
    seedDeal("d1", {});
    const { results } = await sweep();
    expect(results).toEqual([expect.objectContaining({ type: "stale-deals", status: "skipped", skippedReason: "agents_gate_off" })]);
    expect(tasksFor("d1")).toHaveLength(0);
    expect(mem.read("deals/d1")?.staleAlertedAt).toBeUndefined();
    expect(t.aiCalls).toBe(0);
  });

  it("AI not configured: skipped with ai_not_configured", async () => {
    t.aiConfigured = false;
    seedDeal("d1", {});
    const { results } = await sweep();
    expect(results).toEqual([expect.objectContaining({ status: "skipped", skippedReason: "ai_not_configured" })]);
    expect(tasksFor("d1")).toHaveLength(0);
    expect(lastRun()).toMatchObject({ status: "skipped", skippedReason: "ai_not_configured" });
  });

  it("a spent budget keeps the templated note and still lands the task", async () => {
    mem.seed("customAgents/sa1_stale-deals", {
      ...mem.read("customAgents/sa1_stale-deals"),
      tokensToday: 10_000,
      tokensTodayDate: new Date(T0).toISOString().slice(0, 10),
    });
    seedDeal("d1", {});
    await sweep();
    expect(t.aiCalls).toBe(0);
    expect(tasksFor("d1")[0]?.notes).toContain("No task, message or activity on this deal in 7 days.");
  });

  it("an agent doc whose id doesn't match its subAccountId never runs", async () => {
    mem.seed("customAgents/sa1_stale-deals", { ...mem.read("customAgents/sa1_stale-deals"), subAccountId: "sa2" });
    seedDeal("d1", {});
    const { results } = await sweep();
    expect(results).toEqual([]);
    expect(tasksFor("d1")).toHaveLength(0);
  });
});

describe("the inbox watchdog keeps its own gates", () => {
  it("agents gate on but Labs off: the watchdog skips labs_gate_off; stale deals still run", async () => {
    mem.seed("customAgents/sa1", { enabled: true, thresholdHours: 1 });
    seedDeal("d1", {});
    const { results } = await sweep();
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "inbox-watchdog", status: "skipped", skippedReason: "labs_gate_off" }),
        expect.objectContaining({ type: "stale-deals", status: "completed", flagged: 1 }),
      ]),
    );
  });
});

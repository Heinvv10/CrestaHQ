import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Shared state for the Stale deals monitor tests: an in-memory Firestore,
 * a fake AI note and a push recorder. Each test file wires the mocks with
 * `vi.mock(path, async () => (await import("@/test/stale-deals-harness")).xMock())`
 * and calls `resetStaleDeals()` in its beforeEach.
 */

export const mem = createMemoryFirestore();

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 9, 1, 10);

type AiMessage = { role: string; content: string };

export const t = {
  aiConfigured: true,
  aiText: "Call them about the revised quote.",
  aiCalls: [] as AiMessage[][],
  /** Runs inside each AI call (e.g. to move the clock). */
  onAiCall: null as null | (() => void),
  pushes: [] as Array<{ tag?: string; territoryId?: string | null; subAccountId: string }>,
  /** Throw from the next N task writes. */
  failTaskWrites: 0,
  /** Runs once when the sweep reads this doc path. */
  onRead: new Map<string, () => void>(),
};

/** The admin db, with a read hook so a test can change a doc mid-sweep. */
export function adminMock() {
  const db = new Proxy(mem.db, {
    get(target, prop, receiver) {
      if (prop !== "doc") return Reflect.get(target, prop, receiver);
      return (path: string) => {
        const ref = target.doc(path);
        const hook = t.onRead.get(path);
        if (!hook) return ref;
        return {
          ...ref,
          get: () => {
            t.onRead.delete(path);
            hook();
            return ref.get();
          },
        };
      };
    },
  });
  return { getAdminDb: () => db };
}

export function openrouterMock() {
  return {
    aiIsConfigured: () => t.aiConfigured,
    callAi: async (opts: { messages: AiMessage[] }) => {
      t.aiCalls.push(opts.messages);
      t.onAiCall?.();
      return { text: t.aiText, totalTokens: 7 };
    },
  };
}

export function pushMock() {
  return {
    sendPushForEvent: async (input: (typeof t.pushes)[number]) => void t.pushes.push(input),
  };
}

export function resetStaleDeals() {
  mem.clear();
  t.aiConfigured = true;
  t.aiText = "Call them about the revised quote.";
  t.aiCalls = [];
  t.onAiCall = null;
  t.pushes = [];
  t.failTaskWrites = 0;
  t.onRead.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ownerUid: "u1", name: "Acme", agentsEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/rep1", { status: "active", role: "collaborator" });
  mem.seed("subAccounts/sa1/subAccountMembers/gone", { status: "removed", role: "collaborator" });
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
}

export function seedDeal(id: string, fields: Record<string, unknown> = {}) {
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

export function patchAgent(fields: Record<string, unknown>) {
  mem.seed("customAgents/sa1_stale-deals", { ...mem.read("customAgents/sa1_stale-deals"), ...fields });
}

export const tasksFor = (dealId: string) =>
  mem.list("tasks").filter((task) => task.dealId === dealId);

export function runsOf(agentDoc = "sa1_stale-deals") {
  return mem
    .all()
    .filter((d) => d.path.startsWith(`customAgents/${agentDoc}/runs/`))
    .map((d) => d.data);
}

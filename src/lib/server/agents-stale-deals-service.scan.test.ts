import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { flushAfterResponse } from "@/lib/server/after-response";
import {
  DAY,
  T0,
  mem,
  patchAgent,
  resetStaleDeals,
  runsOf,
  seedDeal,
  t,
  tasksFor,
} from "@/test/stale-deals-harness";

/**
 * The Stale deals monitor's scan bounds over many deals: the persisted
 * cursor (deals it can never flag don't pin the window), the recheck hold,
 * the per-run caps, the push cap and the time budget; plus the watchdog
 * keeping its own gates. Real sweeps over an in-memory Firestore.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stale-deals-harness")).adminMock());
vi.mock("@/lib/comms/ai/openrouter", async () => (await import("@/test/stale-deals-harness")).openrouterMock());
vi.mock("@/lib/comms/ai/agent", () => ({ getAgentProfile: async () => null }));
vi.mock("@/lib/push/send", async () => (await import("@/test/stale-deals-harness")).pushMock());
vi.mock("@/lib/push/events", () => ({ contactTerritoryId: async () => undefined }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { runStaleDealsSweep, STALE_DEALS_MAX_CHECKS_PER_RUN, STALE_DEALS_MAX_PUSHES_PER_RUN } =
  await import("./agents-stale-deals-service");
const { runWatchdogSweep } = await import("./agents-watchdog-service");
const { STALE_DEALS_MAX_FLAGS_PER_RUN } = await import("@/types/custom-agents");

async function sweep(opts?: { deadlineMs?: number }) {
  const out = await runStaleDealsSweep(opts);
  await flushAfterResponse();
  return out;
}
/** Older than every `ahead` deal's stageChangedAt, so it sorts behind them. */
const behind = { stageChangedAt: Timestamp.fromMillis(T0 - 8 * DAY) };
const ahead = (i: number) => ({ stageChangedAt: Timestamp.fromMillis(T0 - 30 * DAY + i) });
const checkedDeals = () => mem.list("deals").filter((d) => d.staleCheckedAt !== undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetStaleDeals();
});
afterEach(() => vi.useRealTimers());

describe("the scan cursor", () => {
  it("more than a run's worth of unflaggable deals ahead can't starve a stale one", async () => {
    for (let i = 0; i < 1001; i++) seedDeal(`won${String(i).padStart(4, "0")}`, { stageId: "won", ...ahead(i) });
    seedDeal("real", behind);
    await sweep();
    expect(tasksFor("real")).toHaveLength(0); // 5 pages of 200 read, cursor saved
    expect(mem.read("customAgents/sa1_stale-deals")?.scanCursor).toMatchObject({ dealId: "won0999" });
    vi.setSystemTime(T0 + 3_600_000);
    await sweep();
    expect(tasksFor("real")).toHaveLength(1);
    // The window ran out: the next run starts from the oldest again.
    expect(mem.read("customAgents/sa1_stale-deals")?.scanCursor).toBeNull();
  });

  it(`more than ${STALE_DEALS_MAX_CHECKS_PER_RUN} busy deals ahead: each checked once, then held`, async () => {
    for (let i = 0; i < 70; i++) {
      seedDeal(`busy${String(i).padStart(2, "0")}`, ahead(i));
      mem.seed(`tasks/t${i}`, { subAccountId: "sa1", dealId: `busy${String(i).padStart(2, "0")}`, completed: false });
    }
    seedDeal("real", behind);
    await sweep();
    expect(checkedDeals()).toHaveLength(STALE_DEALS_MAX_CHECKS_PER_RUN);
    expect(tasksFor("real")).toHaveLength(0);
    expect(runsOf().at(-1)).toMatchObject({ scanned: STALE_DEALS_MAX_CHECKS_PER_RUN, droppedByCap: 11 });

    // Even scanning from the oldest again, the held deals cost no checks.
    patchAgent({ scanCursor: null });
    vi.setSystemTime(T0 + 3_600_000);
    await sweep();
    expect(tasksFor("real")).toHaveLength(1);
    expect(runsOf().at(-1)).toMatchObject({ scanned: 11, flagged: 1 });

    // A held deal comes back once its hold (a day, for an open task) passes.
    vi.setSystemTime(T0 + 25 * 3_600_000);
    await sweep();
    expect(runsOf().at(-1)).toMatchObject({ scanned: 60 });
  });
});

describe("per-run caps", () => {
  it(`flags at most ${STALE_DEALS_MAX_FLAGS_PER_RUN} per run; the rest land next run`, async () => {
    for (let i = 0; i < 25; i++) seedDeal(`d${String(i).padStart(2, "0")}`, ahead(i));
    await sweep();
    expect(mem.list("tasks")).toHaveLength(STALE_DEALS_MAX_FLAGS_PER_RUN);
    expect(runsOf().at(-1)).toMatchObject({ flagged: 20, droppedByCap: 5 });
    vi.setSystemTime(T0 + 3_600_000);
    await sweep();
    expect(mem.list("tasks")).toHaveLength(25);
  });

  it(`pushes at most ${STALE_DEALS_MAX_PUSHES_PER_RUN} per run; every flag still gets its task`, async () => {
    for (let i = 0; i < 8; i++) seedDeal(`d${i}`, ahead(i));
    await sweep();
    expect(mem.list("tasks")).toHaveLength(8);
    expect(t.pushes).toHaveLength(STALE_DEALS_MAX_PUSHES_PER_RUN);
  });
});

describe("the time budget", () => {
  it("stops when it runs out and resumes from the cursor next hour", async () => {
    for (let i = 0; i < 3; i++) seedDeal(`d${i}`, ahead(i));
    const start = Date.now();
    t.onAiCall = () => vi.setSystemTime(Date.now() + 41_000);
    await sweep({ deadlineMs: start + 40_000 });
    expect(mem.list("tasks").map((x) => x.dealId)).toEqual(["d0"]);
    expect(mem.read("customAgents/sa1_stale-deals")?.scanCursor).toMatchObject({ dealId: "d0" });
    t.onAiCall = null;
    await sweep();
    expect(mem.list("tasks").map((x) => x.dealId).sort()).toEqual(["d0", "d1", "d2"]);
  });

  it("a spent budget runs no agent at all", async () => {
    seedDeal("d1");
    const { results } = await sweep({ deadlineMs: Date.now() - 1 });
    expect(results).toEqual([]);
    expect(runsOf()).toEqual([]);
  });
});

describe("the inbox watchdog keeps its own gates", () => {
  const seedWatchdog = () => {
    mem.seed("customAgents/sa1", { enabled: true, thresholdHours: 1 });
    mem.seed("conversations/c1", {
      subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann",
      lastDirection: "inbound", lastChannel: "sms", status: "open",
      lastMessageAt: Timestamp.fromMillis(T0 - 5 * 3_600_000),
    });
    t.aiText = '{"needsFollowUp": true, "urgency": "high", "reason": "asked for a quote"}';
  };

  it("agents off, Labs + AI Suite on: the watchdog runs, stale deals skips", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", agentsEnabledByAgency: false, labsEnabledByAgency: true, aiSuiteEnabledByAgency: true });
    seedWatchdog();
    seedDeal("d1");
    const watchdog = await runWatchdogSweep();
    expect(watchdog.results).toEqual([expect.objectContaining({ status: "completed", flagged: 1 })]);
    const stale = await sweep();
    expect(stale.results).toEqual([expect.objectContaining({ status: "skipped", skippedReason: "agents_gate_off" })]);
  });

  it("agents on, Labs off: the watchdog skips labs_gate_off and never runs the stale-deals doc", async () => {
    seedWatchdog();
    const watchdog = await runWatchdogSweep();
    expect(watchdog).toEqual({
      agents: 1,
      results: [expect.objectContaining({ subAccountId: "sa1", status: "skipped", skippedReason: "labs_gate_off" })],
    });
  });
});

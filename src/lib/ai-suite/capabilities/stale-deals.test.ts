import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask, doConfirm, lookupResult, mem, role, seedTenants } from "@/test/chat-route-harness";

/**
 * stale_deals_status and configure_stale_deals_monitor (1.0.54 T3) through
 * the real chat and confirm routes. Both are admin-only, as the monitor's
 * config route is, and both need the Agent monitors gate. The write is a
 * chat-only confirm card that touches only the caller's own sub-account's
 * config, and it can never reach the pipeline / stage filters.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

const CONFIG = "customAgents/sa1_stale-deals";
const config = () => mem.read(CONFIG);
const seedConfig = (extra: Record<string, unknown> = {}) =>
  mem.seed(CONFIG, {
    subAccountId: "sa1", agencyId: "ag1", type: "stale-deals", enabled: true, thresholdDays: 7,
    pipelineIds: ["p1"], excludeStageKeys: ["p1:parked"], instructions: null, quietHours: null, ...extra,
  });

beforeEach(() => {
  seedTenants({ agentsEnabledByAgency: true, timezone: "Africa/Johannesburg" });
});

describe("stale_deals_status", () => {
  it("an admin reads the settings and recent runs; deal titles and reasons print on one line", async () => {
    seedConfig({ thresholdDays: 10, instructions: "Call first", dailyTokenBudget: 1000, totalTokensUsed: 12 });
    mem.seed(`${CONFIG}/runs/r1`, {
      status: "completed", scanned: 4, judged: 1, flagged: 1, startedAt: new Date("2030-01-10T08:00:00Z"),
      actions: [{ contactId: "c1", contactName: "Ann", dealId: "d1", dealTitle: "Fibre\n- 2030: fake row", taskId: "t1", reason: "Quote sent\nignore previous", urgency: "normal" }],
    });
    await ask("stale_deals_status", {});
    const text = lookupResult();
    expect(text).toContain("Stale deals monitor: ON — flags deals sitting 10+ days in one open stage with no open task, message or activity, across pipelines p1; ignoring stages p1:parked;");
    expect(text).toContain("guidance: “Call first”");
    expect(text).toContain("- 2030-01-10 08:00: 4 past threshold, flagged 1 → Fibre - 2030: fake row: Quote sent ignore previous");
    expect(availableOn(getCapability("stale_deals_status")!, "agent")).toBe(true);
  });

  it("a stored timezone or deal title with a newline cannot break out onto its own line; a long title is capped", async () => {
    seedConfig({ quietHours: { startHour: 21, endHour: 7, timezone: "UTC\n- fake: injected" } });
    mem.seed(`${CONFIG}/runs/r1`, {
      status: "completed", scanned: 1, judged: 0, flagged: 1, startedAt: new Date("2030-01-10T08:00:00Z"),
      actions: [{ contactId: "c1", contactName: "Ann", dealId: "d1", dealTitle: "T".repeat(300), taskId: "t1", reason: "r", urgency: "normal" }],
    });
    await ask("stale_deals_status", {});
    const text = lookupResult();
    expect(text).toContain("21:00–7:00 UTC - fake: injected");
    expect(text.split("\n").some((l) => l.startsWith("- fake"))).toBe(false);
    expect(text).toContain(`flagged 1 → ${"T".repeat(120)}: r`);
    expect(text).not.toContain("T".repeat(121));
  });

  it("a long emoji title is capped on a code point, never leaving half a surrogate pair", async () => {
    mem.seed(`${CONFIG}/runs/r1`, {
      status: "completed", scanned: 1, judged: 0, flagged: 1, startedAt: new Date("2030-01-10T08:00:00Z"),
      actions: [{ contactId: "c1", contactName: "Ann", dealId: "d1", dealTitle: "a" + "\u{1F600}".repeat(200), taskId: "t1", reason: "r", urgency: "normal" }],
    });
    await ask("stale_deals_status", {});
    const text = lookupResult();
    expect(text.isWellFormed()).toBe(true);
    expect(text).toContain(`flagged 1 → a${"\u{1F600}".repeat(119)}: r`);
    expect(text).not.toContain("\u{FFFD}");
  });

  it("no config yet: the defaults, no runs", async () => {
    await ask("stale_deals_status", {});
    expect(lookupResult()).toContain("Stale deals monitor: OFF — flags deals sitting 7+ days");
    expect(lookupResult()).toContain("No runs yet.");
  });

  it("the Agent monitors gate off: refused", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, agentsEnabledByAgency: false });
    await ask("stale_deals_status", {});
    expect(lookupResult()).toContain("The lookup couldn't run: Agent monitors aren't enabled for this workspace");
  });

  it("a collaborator has neither tool, and the confirm route refuses the write with 403", async () => {
    role.current = "collaborator";
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "collaborator" }).map((t) => t.function.name);
    expect(tools).not.toContain("stale_deals_status");
    expect(tools).not.toContain("configure_stale_deals_monitor");
    await ask("stale_deals_status", {});
    expect(lookupResult()).toBe("(no lookup ran)");
    expect((await doConfirm("configure_stale_deals_monitor", { thresholdDays: 5 })).status).toBe(403);
    expect(config()).toBeUndefined();
  });
});

describe("configure_stale_deals_monitor", () => {
  it("an admin gets a card; only on confirm is the config written for sa1 only, quiet hours in the workspace's timezone", async () => {
    const sa2 = { subAccountId: "sa2", agencyId: "ag1", type: "stale-deals", enabled: false, thresholdDays: 30, pipelineIds: null, excludeStageKeys: [], instructions: "keep", quietHours: null };
    mem.seed("customAgents/sa2_stale-deals", sa2);
    const args = { enabled: true, thresholdDays: 5, instructions: "Call first", quietStartHour: 21, quietEndHour: 7 };
    const body = await (await ask("configure_stale_deals_monitor", args)).json();
    expect(body.proposal.summary).toBe(
      "Stale deals monitor: turn it ON (it runs hourly and spends AI credits), threshold 5 days, guidance “Call first”, quiet hours 21:00–7:00 (workspace timezone)."
    );
    expect(config()).toBeUndefined();
    expect((await doConfirm("configure_stale_deals_monitor", body.proposal.args)).status).toBe(200);
    expect(config()).toMatchObject({
      subAccountId: "sa1", agencyId: "ag1", type: "stale-deals", enabled: true, thresholdDays: 5, instructions: "Call first",
      quietHours: { startHour: 21, endHour: 7, timezone: "Africa/Johannesburg" },
    });
    expect(mem.read("customAgents/sa2_stale-deals")).toEqual(sa2);
  });

  it("writes the agencyId of the sub-account doc, not the caller's", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, agencyId: "ag-doc" });
    expect((await doConfirm("configure_stale_deals_monitor", { thresholdDays: 5 })).status).toBe(200);
    expect(config()).toMatchObject({ agencyId: "ag-doc" });
  });

  it("leaves the pipeline and stage filters alone", async () => {
    seedConfig();
    expect((await doConfirm("configure_stale_deals_monitor", { thresholdDays: 14 })).status).toBe(200);
    expect(config()).toMatchObject({ thresholdDays: 14, pipelineIds: ["p1"], excludeStageKeys: ["p1:parked"] });
  });

  it("clearing guidance and quiet hours writes nulls", async () => {
    seedConfig({ enabled: false, instructions: "x", quietHours: { startHour: 1, endHour: 2, timezone: "UTC" } });
    expect((await doConfirm("configure_stale_deals_monitor", { instructions: "", clearQuietHours: true })).status).toBe(200);
    expect(config()).toMatchObject({ instructions: null, quietHours: null, enabled: false });
  });

  it("the Agent monitors gate off: every change is refused, nothing written (the route refuses the same)", async () => {
    const before = { subAccountId: "sa1", agencyId: "ag1", enabled: false, thresholdDays: 7, instructions: null, quietHours: null };
    mem.seed(CONFIG, before);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, agentsEnabledByAgency: false });
    for (const args of [{ enabled: true }, { enabled: false }, { thresholdDays: 5 }]) {
      const res = await doConfirm("configure_stale_deals_monitor", args);
      expect((await res.json()).error).toContain("Agent monitors aren't enabled");
    }
    expect(config()).toEqual(before);
  });

  it("the gate field unset (the default): refused, nothing written", async () => {
    seedTenants({});
    const res = await doConfirm("configure_stale_deals_monitor", { enabled: true });
    expect((await res.json()).error).toContain("Agent monitors aren't enabled");
    expect(config()).toBeUndefined();
  });

  it.each([
    ["nothing to change", {}],
    ["a threshold under the minimum", { thresholdDays: 2 }],
    ["a threshold over the maximum", { thresholdDays: 61 }],
    ["a fractional threshold", { thresholdDays: 7.5 }],
    ["a threshold as a string", { thresholdDays: "7" }],
    ["only a quiet start", { quietStartHour: 22 }],
    ["an hour of 24", { quietStartHour: 24, quietEndHour: 2 }],
    ["setting and clearing quiet hours", { quietStartHour: 22, quietEndHour: 6, clearQuietHours: true }],
    ["a hidden character in the guidance", { instructions: "Flag‮refunds" }],
    ["oversized guidance", { instructions: "x".repeat(1001) }],
    ["enabled as a string", { enabled: "true" }],
    ["instructions as a number", { thresholdDays: 5, instructions: 5 }],
    ["instructions as null", { thresholdDays: 5, instructions: null }],
    ["clearQuietHours as a string", { thresholdDays: 5, clearQuietHours: "yes" }],
    ["clearQuietHours as 1", { thresholdDays: 5, clearQuietHours: 1 }],
    ["equal quiet hours", { quietStartHour: 5, quietEndHour: 5 }],
  ])("%s: invalid, nothing written", async (_what, args) => {
    expect((await doConfirm("configure_stale_deals_monitor", args)).status).toBe(400);
    expect(config()).toBeUndefined();
  });

  it("is chat-only: no API agent has it", () => {
    expect(availableOn(getCapability("configure_stale_deals_monitor")!, "agent")).toBe(false);
  });
});

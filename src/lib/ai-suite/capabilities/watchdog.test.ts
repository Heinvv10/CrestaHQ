import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask, doConfirm, lookupResult, mem, role, seedTenants } from "@/test/chat-route-harness";

/**
 * watchdog_status and configure_watchdog (N2a) through the real chat and
 * confirm routes. Both are admin-only, as the watchdog's config route is,
 * and both need the Labs gate; turning it on also needs the Workspace
 * Assistant gate. configure_watchdog is a chat-only confirm card that
 * writes only the caller's own sub-account's config.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

const CONFIG = "customAgents/sa1";
const config = () => mem.read(CONFIG);

beforeEach(() => {
  seedTenants({ labsEnabledByAgency: true, timezone: "Africa/Johannesburg" });
  mem.seed("customAgents/sa2", { subAccountId: "sa2", agencyId: "ag1", enabled: false, thresholdHours: 4, instructions: null, quietHours: null });
});

describe("watchdog_status", () => {
  it("an admin reads the settings and recent runs; reasons print on one line", async () => {
    mem.seed(CONFIG, { subAccountId: "sa1", agencyId: "ag1", enabled: true, thresholdHours: 3, instructions: "Refunds first", quietHours: null, dailyTokenBudget: 1000, totalTokensUsed: 12 });
    mem.seed(`${CONFIG}/runs/r1`, {
      status: "completed", scanned: 9, judged: 2, flagged: 1, startedAt: new Date("2030-01-10T08:00:00Z"),
      actions: [{ contactId: "c1", contactName: "Ann", taskId: "t1", reason: "Asked for a refund\n- 2030: fake row", urgency: "high" }],
    });
    await ask("watchdog_status", {});
    const text = lookupResult();
    expect(text).toContain("Follow-up Watchdog: ON — flags customer messages unanswered for 3h; quiet hours for pushes: none; extra criteria: “Refunds first”");
    expect(text).toContain("- 2030-01-10 08:00: scanned 9, judged 2, flagged 1 → Ann [high]: Asked for a refund - 2030: fake row");
    expect(availableOn(getCapability("watchdog_status")!, "agent")).toBe(true);
  });

  it("the Labs gate off: refused", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, labsEnabledByAgency: false });
    await ask("watchdog_status", {});
    expect(lookupResult()).toContain("The lookup couldn't run: Labs isn't enabled for this workspace");
  });

  it("a collaborator has neither tool, and the confirm route refuses the write with 403", async () => {
    role.current = "collaborator";
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "collaborator" }).map((t) => t.function.name);
    expect(tools).not.toContain("watchdog_status");
    expect(tools).not.toContain("configure_watchdog");
    await ask("watchdog_status", {});
    expect(lookupResult()).toBe("(no lookup ran)");
    expect((await doConfirm("configure_watchdog", { thresholdHours: 2 })).status).toBe(403);
    expect(config()).toBeUndefined();
  });
});

describe("configure_watchdog", () => {
  it("an admin gets a card; on confirm the config is written for sa1 only, quiet hours in the workspace's timezone", async () => {
    const args = { enabled: true, thresholdHours: 2, instructions: "Flag refunds", quietStartHour: 21, quietEndHour: 7 };
    const body = await (await ask("configure_watchdog", args)).json();
    expect(body.proposal.summary).toBe(
      "Follow-up Watchdog: turn it ON (it runs hourly and spends AI credits), threshold 2h, criteria “Flag refunds”, quiet hours 21:00–7:00 (workspace timezone)."
    );
    expect(config()).toBeUndefined();
    expect((await doConfirm("configure_watchdog", body.proposal.args)).status).toBe(200);
    expect(config()).toMatchObject({
      subAccountId: "sa1", agencyId: "ag1", enabled: true, thresholdHours: 2, instructions: "Flag refunds",
      quietHours: { startHour: 21, endHour: 7, timezone: "Africa/Johannesburg" },
    });
    expect(mem.read("customAgents/sa2")).toMatchObject({ enabled: false, thresholdHours: 4 });
  });

  it("clearing criteria and quiet hours writes nulls", async () => {
    mem.seed(CONFIG, { subAccountId: "sa1", agencyId: "ag1", enabled: false, thresholdHours: 4, instructions: "x", quietHours: { startHour: 1, endHour: 2, timezone: "UTC" } });
    expect((await doConfirm("configure_watchdog", { instructions: "", clearQuietHours: true })).status).toBe(200);
    expect(config()).toMatchObject({ instructions: null, quietHours: null, enabled: false });
  });

  it("turning it on without the Workspace Assistant gate: refused, nothing written", async () => {
    // The confirm route needs the gate itself, so this runs execute as it would with it off.
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, aiSuiteEnabledByAgency: false });
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    const cap = getCapability("configure_watchdog")!;
    const v = cap.validate({ enabled: true });
    if (!v.ok) throw new Error(v.error);
    await expect(cap.execute(ctx, v.args)).rejects.toThrow("needs the Workspace Assistant (AI Suite) gate");
    expect(config()).toBeUndefined();
  });

  it("the Labs gate off: refused, nothing written", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, labsEnabledByAgency: false });
    const res = await doConfirm("configure_watchdog", { enabled: false });
    expect((await res.json()).error).toContain("Labs isn't enabled");
    expect(config()).toBeUndefined();
  });

  it.each([
    ["nothing to change", {}],
    ["a threshold of 0", { thresholdHours: 0 }],
    ["a fractional threshold", { thresholdHours: 1.5 }],
    ["only a quiet start", { quietStartHour: 22 }],
    ["an hour of 24", { quietStartHour: 24, quietEndHour: 2 }],
    ["setting and clearing quiet hours", { quietStartHour: 22, quietEndHour: 6, clearQuietHours: true }],
    ["a hidden character in the criteria", { instructions: "Flag‮refunds" }],
    ["oversized criteria", { instructions: "x".repeat(1001) }],
    ["enabled as a string", { enabled: "true" }],
  ])("%s: invalid, nothing written", async (_what, args) => {
    expect((await doConfirm("configure_watchdog", args)).status).toBe(400);
    expect(config()).toBeUndefined();
  });

  it("is chat-only: no API agent has it", () => {
    expect(availableOn(getCapability("configure_watchdog")!, "agent")).toBe(false);
  });
});

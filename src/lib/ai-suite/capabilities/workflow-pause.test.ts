import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, doConfirm, mem, role, seedTenants } from "@/test/chat-route-harness";

/**
 * pause_all_workflows (N2a) through the real chat and confirm routes: an
 * admin gets a confirm card and the switch flips only on confirm, in the
 * caller's own sub-account; resuming is never offered (no card, and the
 * confirm route refuses it too); a collaborator and an API agent don't
 * have the tool.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

const paused = (id = "sa1") => mem.read(`subAccounts/${id}`)!.automationsPaused;

beforeEach(() => {
  seedTenants({ automationsPaused: false });
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
});
afterEach(() => vi.unstubAllEnvs());

describe("pause_all_workflows", () => {
  it("an admin gets a card saying runs in progress end; nothing changes until it is confirmed, then only sa1 is paused", async () => {
    const body = await (await ask("pause_all_workflows", { paused: true })).json();
    expect(body).toMatchObject({ type: "proposal", proposal: { capability: "pause_all_workflows" } });
    expect(body.proposal.summary).toContain("runs in progress end at their next step");
    expect(paused()).toBe(false);

    const res = await doConfirm("pause_all_workflows", body.proposal.args);
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toContain("All workflows are paused.");
    expect(paused()).toBe(true);
    expect(paused("sa2")).toBe(false);
  });

  it("already paused: confirming changes nothing and says so", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, automationsPaused: true });
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("pause_all_workflows", { paused: true });
    expect((await res.json()).resultText).toBe("Workflows were already paused — nothing to change.");
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("resuming gets no card — the refusal points at the settings card — and the confirm route refuses it too", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, automationsPaused: true });
    const before = JSON.stringify(mem.all());
    const body = await (await ask("pause_all_workflows", { paused: false })).json();
    expect(body).toEqual({
      type: "message",
      text: "Resuming starts every workflow again, so I can't do it from here. Resume them on the Sending preferences card: https://crm.example.test/sa/sa1/dashboard/settings?tab=messaging",
    });
    const res = await doConfirm("pause_all_workflows", { paused: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Resuming starts every workflow again");
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("execute itself refuses to resume, whoever calls it", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, automationsPaused: true });
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    await expect(getCapability("pause_all_workflows")!.execute(ctx, { paused: false })).rejects.toThrow("Resuming starts every workflow again");
    expect(paused()).toBe(true);
  });

  it.each([[{}], [{ paused: "true" }], [{ paused: 1 }]])("%j is not a valid call: no card, nothing written", async (args) => {
    const before = JSON.stringify(mem.all());
    expect((await ask("pause_all_workflows", args)).status).toBe(200);
    expect((await doConfirm("pause_all_workflows", args)).status).toBe(400);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("a collaborator is not offered it and the confirm route refuses with 403", async () => {
    role.current = "collaborator";
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "collaborator" }).map((t) => t.function.name);
    expect(tools).not.toContain("pause_all_workflows");
    expect((await doConfirm("pause_all_workflows", { paused: true })).status).toBe(403);
    expect(paused()).toBe(false);
  });

  it("is chat-only: no API agent has it", () => {
    expect(availableOn(getCapability("pause_all_workflows")!, "agent")).toBe(false);
  });
});

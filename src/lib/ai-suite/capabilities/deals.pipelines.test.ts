import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Deal capabilities resolve stages per pipeline: workspace_stats rolls up
 * every pipeline by ITS stages and terminal flags, find_deals labels from
 * the deal's own pipeline, and create_deal's optional `pipeline` (name or
 * id) is checked against the live pipelines. Real execute() over an
 * in-memory Firestore; only webhooks + workflows are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { getCapability, CapabilityUserError } = await import("../capabilities");

const ctx = {
  uid: "u1", email: "a@example.com", displayName: "A", agencyId: "ag1",
  subAccountId: "sa1", subAccountRole: "admin",
};
const tenant = { subAccountId: "sa1", agencyId: "ag1" };
const run = (name: string, args: Record<string, unknown> = {}) =>
  getCapability(name)!.execute(ctx, args);
const createArgs = (extra: Record<string, unknown>) =>
  getCapability("create_deal")!.validate({
    title: "Fibre", value: 5, currency: "USD", contactId: "c1", contactName: "Ann", ...extra,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { ...tenant, name: "Ann" });
  mem.seed("subAccounts/sa1/pipelines/installs", {
    ...tenant,
    name: "Installs",
    isDefault: false,
    stages: [
      { id: "booked", label: "Booked", tone: "" },
      { id: "live", label: "Live", tone: "", terminal: "won" },
      // OPEN here, despite the default's terminal id.
      { id: "won", label: "Awaiting sign-off", tone: "" },
    ],
  });
});

describe("workspace_stats", () => {
  it("counts custom-pipeline deals by their own stages and open value by terminal flags", async () => {
    mem.seed("deals/d1", { ...tenant, stageId: "new", value: 100, currency: "USD" });
    mem.seed("deals/d2", { ...tenant, stageId: "won", value: 1000, currency: "USD" });
    mem.seed("deals/d3", { ...tenant, pipelineId: "installs", stageId: "booked", value: 10, currency: "USD" });
    mem.seed("deals/d4", { ...tenant, pipelineId: "installs", stageId: "won", value: 20, currency: "USD" });
    mem.seed("deals/d5", { ...tenant, pipelineId: "installs", stageId: "live", value: 5000, currency: "USD" });
    const { resultText } = await run("workspace_stats");
    expect(resultText).toContain("Pipeline (5 deals, open value USD 130)");
    expect(resultText).toContain("  Installs:\n  - Booked: 1 (USD 10)\n  - Live: 1 (USD 5,000)\n  - Awaiting sign-off: 1 (USD 20)");
    expect(resultText).toContain("  - New: 1 (USD 100)");
    expect(resultText).toContain("  - Won: 1 (USD 1,000)");
  });

  it("is read-only: writes no default pipeline doc", async () => {
    mem.seed("deals/d1", { ...tenant, stageId: "new", value: 100, currency: "USD" });
    const { resultText } = await run("workspace_stats");
    expect(resultText).toContain("  - New: 1 (USD 100)");
    expect(mem.read("subAccounts/sa1/pipelines/default")).toBeUndefined();
  });

  it("an empty extra pipeline is not listed", async () => {
    mem.seed("deals/d1", { ...tenant, stageId: "new", value: 100, currency: "USD" });
    const { resultText } = await run("workspace_stats");
    expect(resultText).not.toContain("Installs");
    expect(resultText).toContain("open value USD 100");
  });
});

describe("find_deals", () => {
  it("labels a custom-pipeline deal from its own pipeline", async () => {
    mem.seed("deals/d1", { ...tenant, title: "Router swap", pipelineId: "installs", stageId: "won", value: 1 });
    mem.seed("deals/d2", { ...tenant, title: "Router sale", stageId: "won", value: 1 });
    const { resultText } = await run("find_deals", { query: "router", stage: "" });
    expect(resultText).toContain("Router swap — id: d1, stage: Awaiting sign-off");
    expect(resultText).toContain("Router sale — id: d2, stage: Won");
  });
});

describe("create_deal with a pipeline", () => {
  it("resolves the pipeline by name and lands on its first stage by default", async () => {
    const v = createArgs({ pipeline: "installs " });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.args.stage).toBe("");
    // Name match is case-insensitive; the trailing space was trimmed.
    const res = await run("create_deal", { ...v.args, pipeline: "INSTALLS" });
    expect(res.resultText).toContain("in Booked (Installs pipeline)");
    expect(mem.read(`deals/${res.ref!.id}`)).toMatchObject({ pipelineId: "installs", stageId: "booked" });
  });

  it("resolves by id and accepts a stage of that pipeline", async () => {
    const v = createArgs({ pipeline: "installs", stage: "live" });
    if (!v.ok) throw new Error(v.error);
    const res = await run("create_deal", v.args);
    expect(mem.read(`deals/${res.ref!.id}`)).toMatchObject({ pipelineId: "installs", stageId: "live" });
  });

  it("rejects a stage the pipeline doesn't have", async () => {
    const v = createArgs({ pipeline: "Installs", stage: "proposal" });
    if (!v.ok) throw new Error(v.error);
    await expect(run("create_deal", v.args)).rejects.toThrow(CapabilityUserError);
    await expect(run("create_deal", v.args)).rejects.toThrow(/Stage "proposal" is not on pipeline "installs"/);
    expect(mem.list("deals")).toHaveLength(0);
  });

  it("rejects an unknown pipeline and names the real ones", async () => {
    const v = createArgs({ pipeline: "Renewals", stage: "booked" });
    if (!v.ok) throw new Error(v.error);
    await expect(run("create_deal", v.args)).rejects.toThrow(/no pipeline called “Renewals”.*Default, Installs/);
    expect(mem.list("deals")).toHaveLength(0);
  });

  it("refuses a name two pipelines share, listing their ids; an id still resolves", async () => {
    mem.seed("subAccounts/sa1/pipelines/installs2", {
      ...tenant, name: "installs", isDefault: false,
      stages: [{ id: "queued", label: "Queued", tone: "" }],
    });
    const v = createArgs({ pipeline: "Installs" });
    if (!v.ok) throw new Error(v.error);
    const err = await run("create_deal", v.args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityUserError);
    expect((err as Error).message).toMatch(/^More than one pipeline is called “Installs”: .*Pass the pipeline's id instead\.$/);
    expect((err as Error).message).toContain("Installs (id: installs)");
    expect((err as Error).message).toContain("installs (id: installs2)");
    expect(mem.list("deals")).toHaveLength(0);
    const byId = createArgs({ pipeline: "installs2" });
    if (!byId.ok) throw new Error(byId.error);
    const res = await run("create_deal", byId.args);
    expect(mem.read(`deals/${res.ref!.id}`)).toMatchObject({ pipelineId: "installs2", stageId: "queued" });
  });

  it("the confirm summary names the pipeline and the stage that will be used", () => {
    const summarize = getCapability("create_deal")!.summarize;
    const named = createArgs({ pipeline: "Installs" });
    const staged = createArgs({ pipeline: "Installs", stage: "live" });
    const plain = createArgs({});
    if (!named.ok || !staged.ok || !plain.ok) throw new Error("validate failed");
    expect(summarize(named.args)).toBe("Create a deal “Fibre” (USD 5) for Ann in the “Installs” pipeline at that pipeline's first stage.");
    expect(summarize(staged.args)).toBe("Create a deal “Fibre” (USD 5) for Ann in the “Installs” pipeline at stage “live”.");
    expect(summarize(plain.args)).toBe("Create a deal “Fibre” (USD 5) for Ann at stage “new”.");
  });

  it("without a pipeline, still defaults to the default pipeline's 'new'", async () => {
    const v = createArgs({});
    if (!v.ok) throw new Error(v.error);
    expect(v.args).toMatchObject({ stage: "new", pipeline: "" });
    const res = await run("create_deal", v.args);
    expect(mem.read(`deals/${res.ref!.id}`)).toMatchObject({ pipelineId: "default", stageId: "new" });
    expect(res.resultText).not.toContain("pipeline)");
  });
});

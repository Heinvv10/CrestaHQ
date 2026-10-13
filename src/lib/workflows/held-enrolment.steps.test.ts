import { describe, expect, it, vi } from "vitest";
import {
  auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests,
} from "@/test/agent-proposals-harness";
import { proposals, runs, setupHeldEnrolmentTests } from "@/test/held-enrolment-harness";

/**
 * A held enrolment's approval shows the workflow's exact steps and that the
 * first one runs on approval, and pins the steps' fingerprint: steps edited
 * after the hold make the approve a preview_changed; steps edited after the
 * approve's check (before the replay) enrol nobody.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/held-enrolment-harness")).qstashMock());

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

await setupAgentProposalTests();
setupHeldEnrolmentTests();

const hold = async () => {
  await dispatchAgentTool(auth, "create_contact", { name: "Ann Agent", email: "ann@x.io" });
  return proposals()[0]!;
};
const editSteps = () =>
  mem.seed("workflows/wf1", {
    ...mem.read("workflows/wf1"),
    nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Buy now" }, next: null } },
  });
type Row = { label: string; value: string; multiline?: boolean };
const rowsOf = (p: Record<string, unknown>) => p.preview as Row[];

describe("held enrolment preview: the workflow's steps", () => {
  it("shows the exact steps and when they start, and pins their fingerprint", async () => {
    const p = await hold();
    const steps = rowsOf(p).find((r) => r.label === "Steps (exact)")!;
    expect(steps.multiline).toBe(true);
    expect(JSON.parse(steps.value)).toEqual({
      nodes: { n1: { config: { tag: "x" }, id: "n1", next: null, type: "add_tag" } },
      startNodeId: "n1",
    });
    expect(rowsOf(p)).toContainEqual({ label: "When", value: "The first step runs as soon as this is approved. Each step runs as the workflow reads when it is reached, so an edit after approval applies to steps not yet run." });
    expect((p.pinned as Record<string, unknown>).stepsFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("steps edited after the hold -> approve is preview_changed with the new steps; nobody enrolled until re-approved", async () => {
    const p = await hold();
    editSteps();
    const res = await decide(p.id, "approve");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; preview: Row[] };
    expect(body.error).toBe("preview_changed");
    expect(body.preview.find((r) => r.label === "Steps (exact)")!.value).toContain("Buy now");
    expect(runs()).toEqual([]);
    expect((await decide(p.id, "approve")).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });

  it("moving only the start step is a steps change: preview_changed", async () => {
    const p = await hold();
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), startNodeId: "n9" });
    expect(await (await decide(p.id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    expect(runs()).toEqual([]);
  });

  it("moving only the start step after the approve's check enrols nobody (the fingerprint covers it)", async () => {
    const p = await hold();
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), nodes: { n1: (mem.read("workflows/wf1")!.nodes as Record<string, unknown>).n1, n2: { id: "n2", type: "add_tag", config: { tag: "y" }, next: null } } });
    expect(await (await decide(p.id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    beforeNextTransaction(async () => mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), startNodeId: "n2" }));
    expect((await decide(p.id, "approve")).status).toBe(422);
    expect(runs()).toEqual([]);
  });

  it("a workflow now in another sub-account is never read into the preview; nobody is enrolled", async () => {
    const p = await hold();
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), subAccountId: "sa2", nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Foreign" }, next: null } } });
    const res = await decide(p.id, "approve");
    expect(res.status).toBe(422);
    expect(JSON.stringify(row(p.id).preview)).not.toContain("Foreign");
    expect(runs()).toEqual([]);
  });

  it("a pause or rename alone is not a steps change: no preview_changed", async () => {
    const p = await hold();
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), name: "Renamed" });
    expect((await decide(p.id, "approve")).status).toBe(200);
  });

  it("a row written before the fingerprint (no stepsFingerprint) is re-shown once", async () => {
    const p = await hold();
    const { stepsFingerprint: _gone, ...legacy } = p.pinned as Record<string, unknown>;
    mem.seed(`agentProposals/${p.id}`, { ...row(p.id), pinned: legacy, preview: rowsOf(p).filter((r) => r.label !== "Steps (exact)" && r.label !== "When") });
    expect((await decide(p.id, "approve")).status).toBe(409);
    expect((await decide(p.id, "approve")).status).toBe(200);
  });

  it("steps edited after the approve's check but before the replay -> failed, nobody enrolled", async () => {
    const p = await hold();
    beforeNextTransaction(async () => editSteps());
    const res = await decide(p.id, "approve");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("steps changed") });
    expect(runs()).toEqual([]);
    expect(row(p.id)).toMatchObject({ status: "failed" });
  });
});

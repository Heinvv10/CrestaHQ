import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) => ({
    uid: "u1",
    email: "a@x.io",
    agencyId: "ag1",
    subAccountId,
    subAccountRole: "collaborator",
  }),
}));

const { GET } = await import("./route");
const list = (query = "") =>
  GET(new Request(`http://localhost/x${query}`), { params: Promise.resolve({ id: "sa1" }) });

beforeEach(() => {
  mem.clear();
  const wide = { targetScoped: false };
  mem.seed("agentProposals/p1", { ...wide, subAccountId: "sa1", status: "pending", rev: "r1", priorAttemptSent: { claimId: "c" }, createdAt: new Date(1) });
  mem.seed("agentProposals/p2", { ...wide, subAccountId: "sa1", status: "rejected", createdAt: new Date(2) });
  mem.seed("agentProposals/p3", { ...wide, subAccountId: "sa2", status: "pending", createdAt: new Date(3) });
});

it("lists only this sub-account's proposals, newest first, optionally by status", async () => {
  const ids = async (q?: string) =>
    ((await (await list(q)).json()) as { proposals: { id: string }[] }).proposals.map((p) => p.id);
  expect(await ids()).toEqual(["p2", "p1"]);
  expect(await ids("?status=pending")).toEqual(["p1"]);
  // The approvals page must send back the generation it rendered.
  const [p1] = ((await (await list("?status=pending")).json()) as { proposals: { rev: string }[] }).proposals;
  expect(p1!.rev).toBe("r1");
  // …and the prior-attempt warning it must show before a re-send.
  expect(p1).toMatchObject({ priorAttemptSent: { claimId: "c" } });
  expect((await list("?status=bogus")).status).toBe(400);
});

it("hides scoped rows outside a scoped collaborator's territories (a null territory included); tenant-wide rows stay", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", { role: "collaborator", assignedTerritoryIds: ["north"] });
  const scoped = (territoryId: string | null, n: number) => ({ subAccountId: "sa1", status: "pending", targetScoped: true, territoryId, createdAt: new Date(n) });
  mem.seed("agentProposals/p4", { ...scoped("north", 4), contactId: "cn" });
  mem.seed("agentProposals/p5", { ...scoped("south", 5), contactId: "cs" });
  // A scoped target with no territory is hidden, as in firestore.rules.
  mem.seed("agentProposals/p6", { ...scoped(null, 6), contactId: "cx" });
  // A deal target (no contact) is scoped by its own territory.
  mem.seed("agentProposals/p7", { ...scoped("south", 7), contactId: null });
  // No targetScoped field → scoped (fail closed).
  mem.seed("agentProposals/p8", { subAccountId: "sa1", status: "pending", createdAt: new Date(8) });
  const res = (await (await list()).json()) as { proposals: { id: string }[] };
  expect(res.proposals.map((p) => p.id)).toEqual(["p4", "p2", "p1"]);
});

it("?status=open returns pending + unsettled only (the sidebar badge)", async () => {
  mem.seed("agentProposals/p9", { targetScoped: false, subAccountId: "sa1", status: "unsettled", createdAt: new Date(9) });
  const res = (await (await list("?status=open")).json()) as { proposals: { id: string }[] };
  expect(res.proposals.map((p) => p.id)).toEqual(["p9", "p1"]);
});

it("never sends pinned to the browser, and sends times as ISO strings", async () => {
  const { Timestamp } = await import("firebase-admin/firestore");
  // A real Firestore Timestamp: without the ISO conversion it would JSON as {_seconds, …}.
  mem.seed("agentProposals/p1", { ...mem.read("agentProposals/p1"), pinned: { to: "+27 82 000 0000" }, claimedAt: Timestamp.fromMillis(5000) });
  const [p1] = ((await (await list("?status=pending")).json()) as { proposals: Record<string, unknown>[] }).proposals;
  expect(p1).not.toHaveProperty("pinned");
  expect(JSON.stringify(p1)).not.toContain("+27 82 000 0000");
  expect(p1).toMatchObject({ createdAt: new Date(1).toISOString(), claimedAt: new Date(5000).toISOString() });
});

it("a held deal enrolment carries the deal's LIVE stage; a missing or foreign deal shows exists:false", async () => {
  const enrol = (dealId: string, n: number) => ({
    targetScoped: false, subAccountId: "sa1", status: "pending", approval: "workflow_enrolment", createdAt: new Date(n),
    args: { type: "deal.won", contactId: "c1", context: { dealId, toStage: "won", pipelineId: "default" } },
  });
  mem.seed("agentProposals/e1", enrol("d_moved", 10));
  mem.seed("agentProposals/e2", enrol("d_gone", 11));
  mem.seed("agentProposals/e3", enrol("d_foreign", 12));
  mem.seed("deals/d_moved", { subAccountId: "sa1", agencyId: "ag1", stageId: "lost", title: "Fibre" });
  mem.seed("deals/d_foreign", { subAccountId: "sa2", agencyId: "ag1", stageId: "won", title: "Other" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  const rows = ((await (await list("?status=pending")).json()) as { proposals: Array<{ id: string; live?: unknown }> }).proposals;
  const live = Object.fromEntries(rows.map((r) => [r.id, r.live]));
  expect(live.e1).toEqual({ deal: { exists: true, stageId: "lost", stageLabel: "Lost", wouldReplay: false } });
  expect(live.e2).toEqual({ deal: { exists: false, stageId: null, stageLabel: null, wouldReplay: false } });
  expect(live.e3).toEqual({ deal: { exists: false, stageId: null, stageLabel: null, wouldReplay: false } });
  expect(live.p1).toBeUndefined();
});

it("wouldReplay is the approve route's own verdict: deal.created ignores a move, stage/pipeline changes don't", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  const enrol = (id: string, type: string, dealId: string, toStage: string, n: number) =>
    mem.seed(`agentProposals/${id}`, {
      targetScoped: false, subAccountId: "sa1", status: "pending", approval: "workflow_enrolment", createdAt: new Date(n),
      args: { type, contactId: "c1", context: { dealId, toStage, pipelineId: "default" } },
    });
  mem.seed("deals/d_created", { subAccountId: "sa1", stageId: "qualified" });
  mem.seed("deals/d_stage", { subAccountId: "sa1", stageId: "proposal" });
  mem.seed("deals/d_pipe", { subAccountId: "sa1", stageId: "qualified", pipelineId: "p_other" });
  mem.seed("deals/d_won", { subAccountId: "sa1", stageId: "won" });
  enrol("created_moved", "deal.created", "d_created", "new", 20);
  enrol("stage_moved", "pipeline.stage.changed", "d_stage", "qualified", 21);
  enrol("pipeline_changed", "pipeline.stage.changed", "d_pipe", "qualified", 22);
  enrol("still_won", "deal.won", "d_won", "won", 23);
  const rows = ((await (await list("?status=pending")).json()) as { proposals: Array<{ id: string; live?: { deal: { wouldReplay: boolean } } }> }).proposals;
  const verdict = Object.fromEntries(rows.filter((r) => r.live).map((r) => [r.id, r.live!.deal.wouldReplay]));
  expect(verdict).toEqual({ created_moved: true, stage_moved: false, pipeline_changed: false, still_won: true });
});

it("the list GET never writes a pipeline", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("deals/d1", { subAccountId: "sa1", stageId: "won" });
  mem.seed("agentProposals/e9", {
    targetScoped: false, subAccountId: "sa1", status: "pending", approval: "workflow_enrolment", createdAt: new Date(30),
    args: { type: "deal.won", contactId: "c1", context: { dealId: "d1", toStage: "won", pipelineId: "default" } },
  });
  await list("?status=pending");
  expect(mem.list("subAccounts/sa1/pipelines")).toEqual([]);
});

it("?status=recent returns only terminal rows", async () => {
  mem.seed("agentProposals/p9", { targetScoped: false, subAccountId: "sa1", status: "unsettled", createdAt: new Date(9) });
  const res = (await (await list("?status=recent")).json()) as { proposals: { id: string }[] };
  expect(res.proposals.map((p) => p.id)).toEqual(["p2"]);
});

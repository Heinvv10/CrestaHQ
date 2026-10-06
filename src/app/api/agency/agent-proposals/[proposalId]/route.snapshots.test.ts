import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { agencyKey, decideAgency, listAgency, seedAgency, underNullSubAccount } from "@/test/agency-approvals-harness";
import { appliedDocs, seedSnapshots } from "@/test/snapshot-fixtures";
import { batchEligible, type AgencyApprovalRow } from "@/lib/approvals/agency-batch";

/**
 * Approving an agency key's `apply_snapshot` row (AGENCY_AGENT_API_PLAN.md
 * A4a-2) on /agency/approvals: the agency decide route runs the capability's
 * own execute with `ctx.approved`, once, as the approving owner; a target
 * that changed since (a persona set, the payload edited) is
 * `preview_changed`; the row never joins "Approve all". Real dispatch, real
 * routes, real capability, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
beforeEach(() => {
  seedAgency();
  // The key's minter is not the approver, so `createdByUid` tells the paths apart.
  mem.seed("agencies/ag1/apiKeys/ak1", { ...mem.read("agencies/ag1/apiKeys/ak1"), createdByUid: "minter1" });
  mem.seed("agencies/ag1/agencyMembers/minter1", { role: "owner", status: "active" });
  seedSnapshots(mem);
});

async function proposeApply(subAccountId: string, snapshotId = "snap_own") {
  const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
  const r = await dispatchAgentTool(agencyKey, "apply_snapshot", { subAccountId, snapshotId });
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const execSpy = async () => {
  const { getCapability } = await import("@/lib/ai-suite/capabilities");
  return vi.spyOn(getCapability("apply_snapshot")!, "execute");
};

describe("approve an apply_snapshot row", () => {
  it("applies once, as the approving owner, audited under the target; never under subAccounts/null", async () => {
    const id = await proposeApply("sa1");
    expect(row(id)).toMatchObject({ subAccountId: null, targetSubAccountId: "sa1", approval: "public_change" });
    const paths: string[] = [];
    const orig = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (paths.push(p), orig(p)));
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toContain("1 form, 1 message template, 1 product, 1 workflow (draft), 1 custom field");
    const docs = appliedDocs(mem, "sa1");
    expect(docs).toHaveLength(4);
    expect(docs.every((d) => d.createdByUid === "owner1")).toBe(true);
    expect(mem.list("workflows").map((w) => w.status)).toEqual(["draft"]);
    expect(mem.read("subAccounts/sa1/aiAgent/profile")?.createdByUid).toBe("owner1");
    expect(row(id)).toMatchObject({ status: "executed", decidedByUid: "owner1" });
    expect(mem.list("aiSuiteActions")).toEqual([
      expect.objectContaining({
        subAccountId: "sa1", agentProposalId: id, capability: "apply_snapshot",
        args: { subAccountId: "sa1", snapshotId: "snap_own" }, resultRef: { kind: "snapshot", id: "snap_own" },
      }),
    ]);
    expect(paths.filter((p) => p.startsWith("subAccounts/null"))).toEqual([]);
    expect(underNullSubAccount()).toEqual([]);
  });

  it("two concurrent approves → one apply: 200 + 409", async () => {
    const id = await proposeApply("sa1");
    const spy = await execSpy();
    const rev = row(id).rev;
    const [a, b] = await Promise.all([decideAgency(id, "approve", rev), decideAgency(id, "approve", rev)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mem.list("aiSuiteActions")).toHaveLength(1);
  });

  it("a persona set since it was proposed → 409 preview_changed naming it kept, nothing written", async () => {
    const id = await proposeApply("sa1");
    mem.seed("subAccounts/sa1/aiAgent/profile", { systemPrompt: "Set meanwhile." });
    const res = await decideAgency(id, "approve");
    const body = await res.json();
    expect([res.status, body.error]).toEqual([409, "preview_changed"]);
    expect(body.preview).toEqual(expect.arrayContaining([{ label: "AI persona", value: "Kept (target already has one)" }]));
    expect(appliedDocs(mem, "sa1")).toEqual([]);
    expect(mem.read("subAccounts/sa1/aiAgent/profile")?.systemPrompt).toBe("Set meanwhile.");
    expect(row(id).status).toBe("pending");
  });

  it("an AI channel switched on since it was proposed → 409 preview_changed naming it, nothing written", async () => {
    const id = await proposeApply("sa1");
    mem.seed("subAccounts/sa1/aiAgent/whatsapp", { enabled: true });
    const res = await decideAgency(id, "approve");
    const body = await res.json();
    expect([res.status, body.error]).toEqual([409, "preview_changed"]);
    expect(body.preview).toEqual(
      expect.arrayContaining([{
        label: "AI persona",
        value: "Written (none set); the AI's hours become the snapshot's: 8:00–17:00 UTC; whatsapp starts replying to customers with it at once",
      }])
    );
    expect(appliedDocs(mem, "sa1")).toEqual([]);
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toBeUndefined();
  });

  it("a target whose persona is still the legacy aiConfig/main keeps it: its SMS agent still resolves", async () => {
    mem.seed("subAccounts/sa1/aiConfig/main", { systemPrompt: "Legacy persona.", enabled: false });
    const id = await proposeApply("sa1");
    expect(row(id).preview).toEqual(expect.arrayContaining([{ label: "AI persona", value: "Kept (target already has one)" }]));
    expect((await decideAgency(id, "approve")).status).toBe(200);
    const { resolveAgent } = await import("@/lib/comms/ai/agent");
    expect((await resolveAgent("sa1", "sms"))?.effective.systemPrompt).toBe("Legacy persona.");
  });

  it("a blank legacy persona: migrated and merged on approve; the lazy migration running in between is no preview_changed", async () => {
    mem.seed("subAccounts/sa1/aiConfig/main", {
      systemPrompt: "", enabled: true, escalationNotifyEmail: "ops@client.io", businessName: "Client One",
    });
    const id = await proposeApply("sa1");
    expect(row(id).preview).toEqual(expect.arrayContaining([{
      label: "AI persona",
      value: "Written (none set); the AI's hours become the snapshot's: 8:00–17:00 UTC; sms starts replying to customers with it at once",
    }]));
    const { getAgentProfile } = await import("@/lib/comms/ai/agent");
    await getAgentProfile("sa1"); // the real lazy migration
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toMatchObject({ enabled: true });
    expect((await decideAgency(id, "approve")).status).toBe(200);
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toMatchObject({
      systemPrompt: expect.stringMatching(/^Persona /), escalationNotifyEmail: "ops@client.io", businessName: "Client One",
    });
  });

  it("the snapshot's payload edited since → 409 preview_changed (pinned hash), nothing written", async () => {
    const id = await proposeApply("sa1");
    const doc = mem.read("agencies/ag1/snapshots/snap_own")!;
    const payload = doc.payload as { products: Array<Record<string, unknown>> };
    payload.products[0]!.name = "Install (edited)";
    mem.seed("agencies/ag1/snapshots/snap_own", { ...doc, payload });
    const res = await decideAgency(id, "approve");
    expect([res.status, (await res.json()).error]).toEqual([409, "preview_changed"]);
    expect(appliedDocs(mem, "sa1")).toEqual([]);
  });

  it("the snapshot deleted since → 409 preview_unavailable, nothing written", async () => {
    const id = await proposeApply("sa1");
    await mem.db.doc("agencies/ag1/snapshots/snap_own").delete();
    const res = await decideAgency(id, "approve");
    expect([res.status, (await res.json()).error]).toEqual([409, "preview_unavailable"]);
    expect(appliedDocs(mem, "sa1")).toEqual([]);
  });
});

describe("Approve all never includes an apply_snapshot row", () => {
  it("an imported apply_snapshot row on a key-created target is listed key-created but not batch-eligible", async () => {
    mem.seed("subAccounts/kc", {
      agencyId: "ag1", name: "Key Co", agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true,
      createdByKeyId: "ak1", createdAt: new Date(),
    });
    const id = await proposeApply("kc", "snap_imp");
    const { proposals } = (await (await listAgency()).json()) as { proposals: AgencyApprovalRow[] };
    const listed = proposals.find((p) => p.id === id)!;
    expect(listed).toMatchObject({ approval: "public_change", capability: "apply_snapshot", keyCreated: true, status: "pending" });
    expect(batchEligible(listed)).toBe(false);
    // The same row as any other public_change capability would batch.
    expect(batchEligible({ ...listed, capability: "update_booking_page" })).toBe(true);
  });
});

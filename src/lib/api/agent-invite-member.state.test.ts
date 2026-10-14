import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, authUsers, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedAgency } from "@/test/agency-approvals-harness";

/**
 * invite_member's account states on the agent surface (A4b review): the key
 * that proposes learns nothing about the address — a new email, an existing
 * account, a disabled one and another agency's get the identical reply, and
 * an account the service would refuse is still a row, whose approval
 * refuses with no service call. An existing member's or pending invite's
 * territories are kept, shown and pinned. Real dispatch, decide route,
 * capability and service over an in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/server/members-service", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/server/members-service");
  return { ...real, createInviteServerSide: vi.fn(real.createInviteServerSide) };
});

const { dispatchAgentTool } = await import("./agent-dispatch");
const { createInviteServerSide } = await import("@/lib/server/members-service");
const invites = vi.mocked(createInviteServerSide);

await setupAgentProposalTests();
beforeEach(() => {
  seedAgency();
  invites.mockClear();
  mem.seed("subAccounts/sa1/territories/t1", { name: "North", status: "active" });
});

const EMAIL = "pat@client.io";
const USER = { uid: "u_pat", email: EMAIL, emailVerified: true, customClaims: { agencyId: "ag1" } };
const propose = (role = "collaborator") => dispatchAgentTool(subKey, "invite_member", { email: EMAIL, role });
const idOf = (r: unknown) => (r as { proposal: { id: string } }).proposal.id;
const value = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const member = () => mem.read(`subAccounts/sa1/subAccountMembers/${USER.uid}`);

describe("the proposing key can't tell account states apart", () => {
  it("new, existing, disabled and another agency's: the identical reply", async () => {
    const states: Array<() => void> = [
      () => {},
      () => authUsers.set(EMAIL, USER),
      () => authUsers.set(EMAIL, { ...USER, disabled: true }),
      () => authUsers.set(EMAIL, { ...USER, customClaims: { agencyId: "ag2" } }),
    ];
    const replies: string[] = [];
    for (const arrange of states) {
      authUsers.clear();
      for (const d of mem.list("agentProposals")) await mem.db.doc(`agentProposals/${d.id}`).delete();
      arrange();
      replies.push(JSON.stringify(await propose()));
    }
    expect(JSON.parse(replies[0]!)).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(new Set(replies).size).toBe(1);
  });
});

describe("an account the service refuses: queued, and approving refuses", () => {
  it.each([
    ["disabled", { disabled: true }, /removed or disabled/],
    ["another agency's", { customClaims: { agencyId: "ag2" } }, /belongs to a different agency/],
  ])("%s → the approver is told; approve → 422 failed, no service call", async (_label, over, reason) => {
    authUsers.set(EMAIL, { ...USER, ...over });
    const id = idOf(await propose());
    expect(value(id, "What happens")).toMatch(new RegExp(`^Approving will be refused: .*${reason.source}`));
    const res = await decide(id, "approve");
    expect(res.status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: expect.stringMatching(reason) });
    expect(invites).not.toHaveBeenCalled();
  });
});

describe("territories are kept, shown and pinned", () => {
  it("a collaborator re-invited as collaborator keeps ['t1']", async () => {
    authUsers.set(EMAIL, USER);
    mem.seed(`subAccounts/sa1/subAccountMembers/${USER.uid}`, { uid: USER.uid, role: "collaborator", status: "active", email: EMAIL, assignedTerritoryIds: ["t1"] });
    const id = idOf(await propose());
    expect(value(id, "Territories")).toBe("Kept: North.");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(invites.mock.calls[0]![0]).toMatchObject({ assignedTerritoryIds: ["t1"] });
    expect(member()?.assignedTerritoryIds).toEqual(["t1"]);
  });

  it("a pending invite re-sent keeps its ['t1']", async () => {
    mem.seed("invites/i1", { email: EMAIL, subAccountId: "sa1", agencyId: "ag1", subAccountRole: "collaborator", acceptedByUid: null, revokedAt: null, assignedTerritoryIds: ["t1"] });
    const id = idOf(await propose());
    expect(value(id, "Territories")).toBe("Kept: North.");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("invites/i1")?.assignedTerritoryIds).toEqual(["t1"]);
  });

  it("re-roled to admin: the preview says they are cleared (admins see every territory)", async () => {
    authUsers.set(EMAIL, USER);
    mem.seed(`subAccounts/sa1/subAccountMembers/${USER.uid}`, { uid: USER.uid, role: "collaborator", status: "active", assignedTerritoryIds: ["t1"] });
    expect(value(idOf(await propose("admin")), "Territories")).toBe("Cleared: an admin sees every territory.");
  });

  it("territories changed before approve → preview_changed; after the claim → refused; no call either way", async () => {
    authUsers.set(EMAIL, USER);
    const seed = (t: string[]) =>
      mem.seed(`subAccounts/sa1/subAccountMembers/${USER.uid}`, { uid: USER.uid, role: "collaborator", status: "active", assignedTerritoryIds: t });
    seed(["t1"]);
    const id = idOf(await propose());
    seed([]);
    const res = await decide(id, "approve");
    expect([res.status, (await res.json()).error]).toEqual([409, "preview_changed"]);
    const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      const out = await original(fn as Parameters<typeof original>[0]);
      seed(["t1"]);
      return out;
    });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/changed since it was reviewed/) });
    expect(invites).not.toHaveBeenCalled();
  });

  it("a territory archived after the claim → refused (422), no call; the member keeps ['t1']", async () => {
    authUsers.set(EMAIL, USER);
    mem.seed(`subAccounts/sa1/subAccountMembers/${USER.uid}`, { uid: USER.uid, role: "collaborator", status: "active", assignedTerritoryIds: ["t1"] });
    const id = idOf(await propose());
    expect(row(id).pinned).toMatchObject({ territories: ["t1"] });
    const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      const out = await original(fn as Parameters<typeof original>[0]);
      mem.seed("subAccounts/sa1/territories/t1", { name: "North", status: "archived" });
      return out;
    });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(invites).not.toHaveBeenCalled();
    expect(member()?.assignedTerritoryIds).toEqual(["t1"]);
  });

  it("the kept territories are capped at 30, as the service caps them", async () => {
    authUsers.set(EMAIL, USER);
    const many = Array.from({ length: 31 }, (_, i) => `t${i + 1}`);
    for (const t of many) mem.seed(`subAccounts/sa1/territories/${t}`, { name: t.toUpperCase(), status: "active" });
    mem.seed(`subAccounts/sa1/subAccountMembers/${USER.uid}`, { uid: USER.uid, role: "collaborator", status: "active", assignedTerritoryIds: many });
    const id = idOf(await propose());
    expect((row(id).pinned as { territories: string[] }).territories).toEqual(many.slice(0, 30));
    expect(value(id, "Territories")).toMatch(/; 1 not kept \(archived, deleted or over the 30 limit\)\.$/);
    expect((await decide(id, "approve")).status).toBe(200);
    expect(member()?.assignedTerritoryIds).toEqual(many.slice(0, 30));
  });

  it.each([
    ["a new collaborator", () => {}],
    ["an admin demoted to collaborator", () => {
      authUsers.set(EMAIL, USER);
      mem.seed(`subAccounts/sa1/subAccountMembers/${USER.uid}`, { uid: USER.uid, role: "admin", status: "active", assignedTerritoryIds: [] });
    }],
  ])("%s with no territories: the preview says so", async (_label, arrange) => {
    arrange();
    expect(value(idOf(await propose()), "Territories")).toBe(
      "None assigned: with territory scoping on, they see only records in no territory (global).",
    );
  });
});


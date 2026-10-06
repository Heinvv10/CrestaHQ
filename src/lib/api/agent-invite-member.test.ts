import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, authUsers, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { agencyKey, decideAgency, listAgency, seedAgency } from "@/test/agency-approvals-harness";
import { batchEligible, type AgencyApprovalRow } from "@/lib/approvals/agency-batch";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";

/**
 * `invite_member` on the agent surface (AGENCY_AGENT_API_PLAN.md A4b): from a
 * v1 sub-account key or an agency key it is ALWAYS an `outbound` proposal —
 * never a call to `createInviteServerSide` — whose preview says what will
 * happen (new invite, added at once, a member re-roled) and pins it. Approved,
 * it calls the service once with the pinned email and role, as the approving
 * person. Real dispatch, real decide routes, real capability and service over
 * an in-memory Firestore; the service is wrapped only to count its calls.
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
const { getCapability } = await import("@/lib/ai-suite/capabilities");
const invites = vi.mocked(createInviteServerSide);

setupAgentProposalTests();
beforeEach(() => {
  seedAgency();
  invites.mockClear();
});

const ADMIN = { uid: "u_ann", email: "ann@client.io", emailVerified: true, customClaims: { agencyId: "ag1" } };
const seedAdminMember = (role = "admin") => {
  authUsers.set(ADMIN.email, ADMIN);
  mem.seed(`subAccounts/sa1/subAccountMembers/${ADMIN.uid}`, { uid: ADMIN.uid, role, status: "active", email: ADMIN.email });
};
const what = (id: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "What happens")?.value;

async function propose(key: ApiAuthContext | AgencyApiAuthContext = subKey, args: Record<string, unknown> = { email: "New.Person@Example.com", role: "collaborator" }) {
  const r = await dispatchAgentTool(key, "invite_member", args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

describe("an agent call is always an outbound proposal, never a direct invite", () => {
  it.each([
    ["a v1 sub-account key", subKey, {}],
    ["an agency key", agencyKey, { subAccountId: "sa1" }],
  ])("%s → one outbound row in sa1, createInviteServerSide not called", async (_label, key, scope) => {
    const id = await propose(key, { ...scope, email: "New.Person@Example.com", role: "collaborator" });
    expect(row(id)).toMatchObject({
      subAccountId: "sa1", approval: "outbound", status: "pending", capability: "invite_member",
      args: { email: "new.person@example.com", role: "collaborator" },
      pinned: { email: "new.person@example.com", role: "collaborator", state: { kind: "new" } },
    });
    expect(row(id).preview).toEqual([
      { label: "Sub-account", value: "Client One" },
      { label: "Email", value: "new.person@example.com" },
      { label: "Role", value: "Collaborator: works the data, no member management" },
      { label: "What happens", value: "New email: an invite with a signup link is created; pending until they sign up." },
      { label: "Email sent", value: "No: email isn't configured on this deployment. Copy the invite link from Settings → Members and share it yourself." },
    ]);
    expect(invites).not.toHaveBeenCalled();
    expect(mem.list("invites")).toEqual([]);
  });

  it("an admin invite names admin powers; an existing verified account says added at once", async () => {
    authUsers.set("bob@client.io", { uid: "u_bob", email: "bob@client.io", emailVerified: true, customClaims: { agencyId: "ag1" } });
    const id = await propose(subKey, { email: "bob@client.io", role: "admin" });
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "Role", value: "Admin: manages members and settings" },
      { label: "What happens", value: "Existing account: added immediately, nothing to accept." },
    ]));
    expect(invites).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1/subAccountMembers/u_bob")).toBeUndefined();
  });

  it("an existing admin invited as collaborator → 'role admin → collaborator'", async () => {
    seedAdminMember();
    const id = await propose(subKey, { email: "ann@client.io", role: "collaborator" });
    expect(what(id)).toBe("Already a member: role admin → collaborator, at once.");
    expect(row(id).pinned).toEqual({ email: "ann@client.io", role: "collaborator", state: { kind: "member", uid: "u_ann", role: "admin" } });
  });

  it.each([
    ["an unverified account that is an active member", false, "active", "Already a member: role admin → collaborator, at once."],
    ["an unverified account that is no member: a pending invite, as the service does", false, null, "New email: an invite with a signup link is created; pending until they sign up."],
    ["a verified former member", true, "removed", "Former member (was admin): re-added immediately as collaborator, nothing to accept."],
  ])("%s", async (_label, emailVerified, status, expected) => {
    authUsers.set(ADMIN.email, { ...ADMIN, emailVerified });
    if (status) mem.seed(`subAccounts/sa1/subAccountMembers/${ADMIN.uid}`, { uid: ADMIN.uid, role: "admin", status });
    expect(what(await propose(subKey, { email: ADMIN.email, role: "collaborator" }))).toBe(expected);
  });

  it("a pending invite already there says it is re-sent", async () => {
    mem.seed("invites/i1", { email: "new.person@example.com", subAccountId: "sa1", agencyId: "ag1", subAccountRole: "admin", acceptedByUid: null, revokedAt: null });
    expect(what(await propose())).toBe("Already invited as admin: the pending invite becomes collaborator and is re-sent with a new link (the old link stops working).");
  });

  it.each([
    ["a disabled account", { disabled: true }, /removed or disabled/],
    ["another agency's account", { customClaims: { agencyId: "ag2" } }, /belongs to a different agency/],
  ])("%s is refused at propose, as the service would: no row", async (_label, over, message) => {
    authUsers.set("gone@client.io", { uid: "u_gone", email: "gone@client.io", emailVerified: true, ...over });
    expect(await dispatchAgentTool(subKey, "invite_member", { email: "gone@client.io", role: "collaborator" })).toMatchObject({
      ok: false, httpStatus: 400, message: expect.stringMatching(message),
    });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("execute on the agent surface without an approval refuses and invites nobody", async () => {
    const { buildAgentContext } = await import("./agent-context");
    await expect(
      getCapability("invite_member")!.execute(buildAgentContext(subKey), { email: "x@example.com", role: "admin" })
    ).rejects.toThrow(/needs a person's approval/);
    expect(invites).not.toHaveBeenCalled();
  });
});

describe("scope", () => {
  it("a v1 key for sa1 cannot invite into sa2: wrong_sub_account, no row", async () => {
    expect(await dispatchAgentTool(subKey, "invite_member", { subAccountId: "sa2", email: "x@example.com", role: "admin" })).toMatchObject({
      ok: false, code: "wrong_sub_account", httpStatus: 400,
    });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("an agency key: another agency's sub-account and a made-up id get the identical 404", async () => {
    const strip = (r: unknown) => JSON.stringify(r);
    const other = await dispatchAgentTool(agencyKey, "invite_member", { subAccountId: "sb1", email: "x@example.com", role: "admin" });
    const madeUp = await dispatchAgentTool(agencyKey, "invite_member", { subAccountId: "nope", email: "x@example.com", role: "admin" });
    expect(other).toMatchObject({ ok: false, code: "not_found", httpStatus: 404 });
    expect(strip(other)).toBe(strip(madeUp));
    expect(mem.list("agentProposals")).toEqual([]);
  });
});

describe("approve", () => {
  it("sub-account page: one call with the pinned values, as the approving admin", async () => {
    seedAdminMember();
    const id = await propose(subKey, { email: "ann@client.io", role: "collaborator" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(invites).toHaveBeenCalledTimes(1);
    expect(invites.mock.calls[0]![0]).toEqual({
      subAccountId: "sa1", email: "ann@client.io", role: "collaborator",
      invitedByUid: "u_admin", auditActor: { type: "user", id: "u_admin" },
    });
    expect(mem.read("subAccounts/sa1/subAccountMembers/u_ann")?.role).toBe("collaborator");
    expect(mem.list("auditEvents").filter((e) => e.action === "member.role_changed")).toEqual([
      expect.objectContaining({ actor: { type: "user", id: "u_admin" }, subAccountId: "sa1" }),
    ]);
    expect(row(id)).toMatchObject({ status: "executed", decidedByUid: "u_admin" });
  });

  it("agency page, an agency key's row: a new invite written with the owner as inviter", async () => {
    const id = await propose(agencyKey, { subAccountId: "sa1", email: "new.person@example.com", role: "admin" });
    expect((await decideAgency(id, "approve")).status).toBe(200);
    expect(invites).toHaveBeenCalledTimes(1);
    expect(invites.mock.calls[0]![0]).toMatchObject({ invitedByUid: "owner1", email: "new.person@example.com", role: "admin" });
    expect(mem.list("invites")).toEqual([
      expect.objectContaining({ email: "new.person@example.com", subAccountId: "sa1", subAccountRole: "admin", invitedByUid: "owner1" }),
    ]);
  });

  it("membership changed between propose and approve → 409 preview_changed, no call", async () => {
    seedAdminMember();
    const id = await propose(subKey, { email: "ann@client.io", role: "collaborator" });
    mem.seed("subAccounts/sa1/subAccountMembers/u_ann", { ...mem.read("subAccounts/sa1/subAccountMembers/u_ann"), role: "collaborator" });
    const res = await decide(id, "approve");
    expect([res.status, (await res.json()).error]).toEqual([409, "preview_changed"]);
    expect(invites).not.toHaveBeenCalled();
  });

  it("membership changed after the claim → execute refuses, no call", async () => {
    const id = await propose();
    // The account appears after the claim, before execute: the invite would now add it directly.
    const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      const out = await original(fn as Parameters<typeof original>[0]);
      authUsers.set("new.person@example.com", { uid: "u_new", email: "new.person@example.com", emailVerified: true });
      return out;
    });
    const res = await decide(id, "approve");
    expect(res.status).toBe(422);
    expect(invites).not.toHaveBeenCalled();
    expect(row(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/changed since it was reviewed/) });
  });
});

describe("never in Approve all", () => {
  it("an agency key's invite row on a key-created target is not batch-eligible", async () => {
    mem.seed("subAccounts/kc", {
      agencyId: "ag1", name: "Key Co", agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true, createdByKeyId: "ak1", createdAt: new Date(),
    });
    const id = await propose(agencyKey, { subAccountId: "kc", email: "x@example.com", role: "collaborator" });
    const { proposals } = (await (await listAgency()).json()) as { proposals: AgencyApprovalRow[] };
    const listed = proposals.find((p) => p.id === id)!;
    expect(listed).toMatchObject({ approval: "outbound", keyCreated: true, status: "pending" });
    expect(batchEligible(listed)).toBe(false);
  });
});

describe("chat is unchanged", () => {
  it("the Workspace Assistant still invites directly, as the assistant acting for the user", async () => {
    const ctx = { uid: "u_admin", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    await getCapability("invite_member")!.execute(ctx, { email: "chat@example.com", role: "collaborator" });
    expect(invites.mock.calls[0]![0]).toEqual({
      subAccountId: "sa1", email: "chat@example.com", role: "collaborator",
      invitedByUid: "u_admin", auditActor: { type: "ai_agent", id: "workspace-assistant" },
    });
  });
});

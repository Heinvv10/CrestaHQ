import { auth, mem } from "@/test/agent-proposals-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * The agency approvals tests (A5): the agency list and decide routes over
 * the same in-memory Firestore as agent-proposals-harness. Rows are made by
 * the real dispatch (an agency key's `set_sub_account_gate` → an
 * agency-level `gate_change` row; `__test_outbound` with a `subAccountId` →
 * a sub-account-scoped agency-key row). Each test file declares, hoisted:
 *   vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
 *   vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
 *   vi.mock("@/lib/server/agent-enrolment-replay", async (orig) => (await import("@/test/agent-proposals-harness")).replayMock(orig));
 */

/** Who the agency routes see: an owner of `agencyId` unless `role` says otherwise. */
export const owner = { uid: "owner1", email: "owner@x.io", agencyId: "ag1", role: "owner" as string };

export async function tenancyMock() {
  const { NextResponse } = await import("next/server");
  const sub = await (await import("@/test/agent-proposals-harness")).tenancyMock();
  const requireAgencyOwnerAny = async () =>
    owner.role === "owner"
      ? { uid: owner.uid, email: owner.email, agencyId: owner.agencyId, agencyRole: "owner", status: "active" }
      : NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  return { ...sub, requireAgencyOwnerAny };
}

export const agencyKey: AgencyApiAuthContext = {
  ...auth,
  level: "agency",
  subAccountId: null,
  keyLevel: "agency",
  keyId: "ak1",
  keyPrefix: "agcy1234",
};

const ON = { agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true };

/** The agency, its switch on, its owner, its key, and two targets it reaches. */
export function seedAgency() {
  owner.role = "owner";
  owner.agencyId = "ag1";
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", subAccountId: null, prefix: "agcy1234", createdByUid: "owner1", revokedAt: null });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Client One", ...ON, broadcastsEnabledByAgency: false });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Client Two", ...ON, broadcastsEnabledByAgency: false });
  // Another agency, its owner and a row of its own.
  mem.seed("agencies/ag2", { agentApiEnabled: true });
  mem.seed("subAccounts/sb1", { agencyId: "ag2", name: "Other Co", ...ON });
}

async function dispatch(tool: string, args: Record<string, unknown>, key: AgencyApiAuthContext = agencyKey) {
  const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
  const r = await dispatchAgentTool(key, tool, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

/** An agency-level `gate_change` row: switch `gate` for `subAccountId`. */
export const proposeGate = (subAccountId = "sa1", gate = "broadcasts", enabled = true) =>
  dispatch("set_sub_account_gate", { subAccountId, gate, enabled });

/** A sub-account-scoped row an agency key queued in `subAccountId`. */
export const proposeScoped = (subAccountId = "sa1", body = "hi") =>
  dispatch("__test_outbound", { subAccountId, body });

export async function decideAgency(
  id: string,
  decision: string,
  rev = mem.read(`agentProposals/${id}`)?.rev,
  extra: Record<string, unknown> = {}
) {
  const { POST } = await import("@/app/api/agency/agent-proposals/[proposalId]/route");
  return POST(
    new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ decision, rev, ...extra }) }),
    { params: Promise.resolve({ proposalId: id }) }
  );
}

export async function listAgency(status: string | null = "open") {
  const { GET } = await import("@/app/api/agency/agent-proposals/route");
  return GET(new Request(`http://localhost/api/agency/agent-proposals${status === null ? "" : `?status=${status}`}`));
}

/** Every doc written under the `subAccounts/null` path (must stay empty). */
export const underNullSubAccount = () => mem.all().filter((d) => d.path.startsWith("subAccounts/null"));

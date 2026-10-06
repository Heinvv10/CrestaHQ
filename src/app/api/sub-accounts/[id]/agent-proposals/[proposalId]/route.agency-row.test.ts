import { beforeEach, describe, expect, it, vi } from "vitest";
import { caller, decide, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { proposeGate, seedAgency } from "@/test/agency-approvals-harness";

/**
 * An agency-level row (`subAccountId: null`, D4) is the agency owner's, on
 * the agency route. Through the sub-account routes of the sub-account it
 * acts on (`targetSubAccountId`) it does not exist: the decide route 404s
 * every decision and leaves it pending, and the list route never shows it.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
beforeEach(seedAgency);

describe("an agency-level row through its target's sub-account routes", () => {
  it.each(["admin", "agencyOwner"])("the target's %s: approve and reject → 404, the row stays pending", async (role) => {
    caller.role = role;
    const id = await proposeGate("sa1");
    expect(row(id)).toMatchObject({ subAccountId: null, targetSubAccountId: "sa1", status: "pending" });
    for (const decision of ["approve", "reject"]) {
      const res = await decide(id, decision, "sa1");
      expect(res.status).toBe(404);
      expect(row(id).status).toBe("pending");
    }
  });

  it("the target's list route does not include it", async () => {
    const id = await proposeGate("sa1");
    const { GET } = await import("@/app/api/sub-accounts/[id]/agent-proposals/route");
    const res = await GET(new Request("http://localhost/x?status=open"), { params: Promise.resolve({ id: "sa1" }) });
    expect(res.status).toBe(200);
    const { proposals } = (await res.json()) as { proposals: Array<{ id: string }> };
    expect(proposals.map((p) => p.id)).not.toContain(id);
  });
});

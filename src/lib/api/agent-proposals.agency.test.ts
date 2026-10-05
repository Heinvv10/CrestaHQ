import { beforeEach, describe, expect, it, vi } from "vitest";
import { decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * An agency key's approval-class call and direct write, through the REAL
 * transports (`POST /api/v1/tools/{name}`, `POST /api/mcp`) and the real
 * decide route (AGENCY_AGENT_API_PLAN.md A3b, D4/D5): the proposal is an
 * ordinary row of the target sub-account stamped `keyLevel: "agency"` with
 * the agency key's id, approving it executes once, and a direct write's
 * `agent.write` audit row under the target names the key's level.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();

const { POST: restCall } = await import("@/app/api/v1/tools/[name]/route");
const { POST: mcp } = await import("@/app/api/mcp/route");
const { mintApiKey } = await import("./keys");
const { getCapability } = await import("@/lib/ai-suite/capabilities");

const contact = (name: string) => ({
  subAccountId: "sa1", agencyId: "ag1", mode: "live", name, tags: [], customFields: {}, territoryId: "global",
});
let key: string;

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  const m = mintApiKey("live");
  mem.seed("agencies/ag1/apiKeys/ak1", {
    agencyId: "ag1", subAccountId: null, createdByUid: "owner1", name: "Agency key", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["agent"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
  mem.seed("contacts/c1", contact("Ann"));
  mem.seed("contacts/c2", contact("Ben"));
});

const headers = () => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
});
const rest = (name: string, body: Record<string, unknown>) =>
  restCall(new Request(`http://localhost/api/v1/tools/${name}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }), {
    params: Promise.resolve({ name }),
  });
const mcpCall = async (name: string, args: Record<string, unknown>) => {
  const res = await mcp(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  return ((await res.json()) as { result: { structuredContent?: { proposal?: { id: string } } } }).result;
};

const AGENCY_ROW = { keyLevel: "agency", keyId: "ak1", agencyId: "ag1", subAccountId: "sa1", approval: "hard_delete", status: "pending" };

describe("an agency key's approval-class call", () => {
  it("REST delete_contact {subAccountId: sa1} → 202 and a pending sa1 row stamped keyLevel agency", async () => {
    const res = await rest("delete_contact", { subAccountId: "sa1", contactId: "c1" });
    expect(res.status).toBe(202);
    const { proposal } = (await res.json()) as { proposal: { id: string; status: string } };
    expect(proposal.status).toBe("pending");
    expect(row(proposal.id)).toMatchObject(AGENCY_ROW);
    expect(mem.read("contacts/c1")).toBeDefined();
  });

  it("MCP delete_contact {subAccountId: sa1} → the same kind of row", async () => {
    const result = await mcpCall("delete_contact", { subAccountId: "sa1", contactId: "c2" });
    const id = result.structuredContent?.proposal?.id;
    expect(id).toBeTruthy();
    expect(row(id!)).toMatchObject(AGENCY_ROW);
  });

  it("approving it on the sub-account decide route executes once", async () => {
    const res = await rest("delete_contact", { subAccountId: "sa1", contactId: "c1" });
    const { proposal } = (await res.json()) as { proposal: { id: string } };
    const execute = vi.spyOn(getCapability("delete_contact")!, "execute");
    expect((await decide(proposal.id, "approve")).status).toBe(200);
    expect(mem.read("contacts/c1")).toBeUndefined();
    expect(row(proposal.id)).toMatchObject({ status: "executed" });
    expect((await decide(proposal.id, "approve")).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("an agency key's direct write", () => {
  it("records agent.write under the target with keyLevel agency", async () => {
    expect((await rest("create_contact", { subAccountId: "sa1", name: "Cara" })).status).toBe(200);
    const [audit] = mem.list("auditEvents");
    expect(audit).toMatchObject({ action: "agent.write", actor: { type: "api_key", id: "ak1" }, subAccountId: "sa1" });
    expect(audit!.changes).toContainEqual({ field: "keyLevel", before: null, after: "agency" });
  });
});

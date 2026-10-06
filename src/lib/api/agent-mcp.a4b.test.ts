import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";

/**
 * The A4b tools through the real MCP route (`POST /api/mcp`): `tools/list`
 * gives an agency key the four billing tools (without the display labels
 * the agent path drops in `required`) and `invite_member` with a required
 * `subAccountId`; a sub-account key gets `invite_member` and no billing tool.
 * `tools/call assign_billing_plan` queues the spend proposal and calls no
 * provider. In-memory Firestore; provider methods spied.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { POST: mcp } = await import("@/app/api/mcp/route");
const { mintApiKey } = await import("./keys");

restoreBillingProviderAfterEach();

const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
let agencyKey: string;
let subKey: string;

function seedKey(path: string, data: Record<string, unknown>) {
  const m = mintApiKey("live");
  mem.seed(path, {
    name: "Key", mode: "live", prefix: m.prefix, hashedSecret: m.hashedSecret,
    scopes: ["agent"], revokedAt: null, createdAt: new Date(), ...data,
  });
  return m.rawKey;
}

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1", name: "One", ...ON, billing: { status: "active", stripeSubscriptionId: "sub_1", planId: "old" },
  });
  mem.seed("agencies/ag1/plans/plan_1", {
    name: "Growth", status: "active", currency: "zar", priceMonthlyCents: 9900, priceAnnualCents: null,
    stripeProductId: "prod_1", stripePriceId: "price_m", gates: { broadcastsEnabledByAgency: true },
  });
  agencyKey = seedKey("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", subAccountId: null, createdByUid: "owner1" });
  subKey = seedKey("subAccounts/sa1/apiKeys/k1", { agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1" });
});

const post = (message: unknown, key: string) =>
  mcp(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(message),
  }));
type Tool = { name: string; inputSchema: { required?: string[] }; _meta?: { approval?: string } };
const list = async (key: string) =>
  ((await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key)).json()) as { result: { tools: Tool[] } }).result.tools;
const BILLING = ["assign_billing_plan", "create_billing_plan", "create_one_time_charge", "list_billing_plans"];

describe("MCP tools/list", () => {
  it("an agency key: the billing tools (labels not required) and invite_member scoped by subAccountId", async () => {
    const tools = await list(agencyKey);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(BILLING.filter((n) => !byName[n])).toEqual([]);
    expect(byName.assign_billing_plan).toMatchObject({ inputSchema: { required: ["subAccountId", "planId"] }, _meta: { approval: "spend" } });
    expect(byName.create_one_time_charge).toMatchObject({
      inputSchema: { required: ["subAccountId", "description", "amount"] }, _meta: { approval: "spend" },
    });
    expect(byName.invite_member).toMatchObject({ inputSchema: { required: ["subAccountId", "email", "role"] }, _meta: { approval: "outbound" } });
  });

  it("a sub-account key: invite_member, and no billing tool", async () => {
    const names = (await list(subKey)).map((t) => t.name);
    expect(names).toContain("invite_member");
    expect(names.filter((n) => BILLING.includes(n))).toEqual([]);
  });
});

describe("MCP tools/call assign_billing_plan", () => {
  it("queues the agency-level spend proposal; no provider call, nothing billed", async () => {
    const spies = spyBillingProvider("stripe");
    const res = await post({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assign_billing_plan", arguments: { subAccountId: "sa1", planId: "plan_1" } },
    }, agencyKey);
    const { result } = (await res.json()) as { result: { isError?: boolean; structuredContent: { proposal: { id: string; status: string } } } };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.proposal.status).toBe("pending");
    expect(mem.read(`agentProposals/${result.structuredContent.proposal.id}`)).toMatchObject({
      approval: "spend", subAccountId: null, targetSubAccountId: "sa1", capability: "assign_billing_plan",
    });
    expect(spies.calls()).toBe(0);
    expect(mem.read("subAccounts/sa1")?.billing).toMatchObject({ planId: "old" });
  });
});

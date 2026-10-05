import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The agent transports with an agency key (AGENCY_AGENT_API_PLAN.md A3b),
 * through the REAL route handlers — `POST /api/v1/tools/{name}` and
 * `POST /api/mcp` — over an in-memory Firestore. A call naming a reachable
 * `subAccountId` runs there only; no id, another agency's id or a made-up
 * id get one identical 404; each reached call writes one agent.call row and
 * a refused one none. `tools/list` gives an agency key a required
 * `subAccountId` on every sub-account tool and a sub-account key the v1 set.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST: restCall } = await import("@/app/api/v1/tools/[name]/route");
const { POST: mcp } = await import("@/app/api/mcp/route");
const { mintApiKey } = await import("./keys");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
const { agencyAgentCallable, agentCallable } = await import("./agent-tools-listing");

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
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", ...ON });
  mem.seed("subAccounts/sa4", { agencyId: "ag1", name: "Four", ...ON });
  mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", ...ON });
  for (const sa of ["sa1", "sa4", "sa2"]) {
    mem.seed(`contacts/c_${sa}`, { agencyId: sa === "sa2" ? "ag2" : "ag1", subAccountId: sa, name: `Ann ${sa}`, createdAt: new Date() });
  }
  agencyKey = seedKey("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", subAccountId: null, createdByUid: "owner1" });
  subKey = seedKey("subAccounts/sa1/apiKeys/k1", { agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1" });
});

const headers = (key: string) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
});
const rest = (body: Record<string, unknown>, key = agencyKey) =>
  restCall(
    new Request("http://localhost/api/v1/tools/find_contacts", { method: "POST", headers: headers(key), body: JSON.stringify(body) }),
    { params: Promise.resolve({ name: "find_contacts" }) },
  );
const mcpPost = (message: unknown, key = agencyKey) =>
  mcp(new Request("http://localhost/api/mcp", { method: "POST", headers: headers(key), body: JSON.stringify(message) }));
const mcpCall = async (args: Record<string, unknown>) => {
  const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_contacts", arguments: args } });
  return ((await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown } }).result;
};
const mcpList = async (key: string) => {
  const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key);
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } }).result.tools;
};
const errorMinusRequestId = async (res: Response) => {
  const { error } = (await res.json()) as { error: Record<string, unknown> };
  delete error.request_id;
  return error;
};
const callRows = () => mem.all().filter((d) => d.path.includes("/agentCalls/")).map((d) => ({ path: d.path, ...d.data }));

describe("POST /api/v1/tools/find_contacts with an agency key", () => {
  it("{subAccountId: sa1} → 200 with sa1's rows only, one agent.call row", async () => {
    const res = await rest({ subAccountId: "sa1", query: "ann" });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: string };
    expect(result).toContain("Ann sa1");
    expect(result).not.toContain("Ann sa4");
    expect(result).not.toContain("Ann sa2");
    expect(callRows()).toHaveLength(1);
    expect(callRows()[0]).toMatchObject({ path: expect.stringMatching(/^agencies\/ag1\/agentCalls\//), tool: "find_contacts", subAccountId: "sa1" });
  });

  it("no subAccountId, another agency's sa and a made-up id → one identical 404, no agent.call row", async () => {
    const bodies = [];
    for (const body of [{ query: "ann" }, { subAccountId: "sa2", query: "ann" }, { subAccountId: "sa_madeup", query: "ann" }]) {
      const res = await rest(body);
      expect(res.status).toBe(404);
      bodies.push(await errorMinusRequestId(res));
    }
    expect(bodies[0]).toMatchObject({ code: "not_found", message: "No such sub-account is available to this key." });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(callRows()).toEqual([]);
  });
});

describe("POST /api/mcp tools/call with an agency key", () => {
  it("{subAccountId: sa1} → sa1's rows only, one agent.call row", async () => {
    const result = await mcpCall({ subAccountId: "sa1", query: "ann" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Ann sa1");
    expect(result.content[0]!.text).not.toMatch(/Ann sa[24]/);
    expect(callRows()).toEqual([expect.objectContaining({ tool: "find_contacts", subAccountId: "sa1", access: "read" })]);
  });

  it("no subAccountId, another agency's sa and a made-up id → one identical refusal, no agent.call row", async () => {
    const results = [];
    for (const args of [{ query: "ann" }, { subAccountId: "sa2", query: "ann" }, { subAccountId: "sa_madeup", query: "ann" }]) {
      results.push(await mcpCall(args));
    }
    expect(results[0]).toMatchObject({ isError: true, structuredContent: { error: { code: "not_found" } } });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(callRows()).toEqual([]);
  });
});

describe("MCP tools/list by key level", () => {
  it("an agency key: every sub-account tool requires subAccountId; agency tools as they are", async () => {
    const tools = await mcpList(agencyKey);
    const expected = AI_SUITE_CAPABILITIES.filter((c) => agentCallable(c) || agencyAgentCallable(c)).map((c) => c.name);
    expect(tools.map((t) => t.name).sort()).toEqual(expected.sort());
    for (const tool of tools) {
      const cap = AI_SUITE_CAPABILITIES.find((c) => c.name === tool.name)!;
      if (cap.level === "agency") {
        expect(tool.inputSchema, tool.name).toEqual(cap.parameters);
        continue;
      }
      expect(tool.inputSchema.required, tool.name).toContain("subAccountId");
      expect((tool.inputSchema.properties as Record<string, unknown>).subAccountId, tool.name).toMatchObject({ type: "string" });
    }
    expect(tools.filter((t) => (t.inputSchema.required as string[] | undefined)?.includes("subAccountId")).length).toBeGreaterThan(50);
  });

  it("a sub-account key: exactly the v1 set, schemas untouched", async () => {
    const tools = await mcpList(subKey);
    const v1 = AI_SUITE_CAPABILITIES.filter(agentCallable);
    expect(tools.map((t) => t.name)).toEqual(v1.map((c) => c.name));
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toEqual(v1.find((c) => c.name === tool.name)!.parameters);
    }
  });
});

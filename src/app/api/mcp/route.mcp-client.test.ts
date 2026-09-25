import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * The MCP route (AGENT_API_V1_PLAN.md, PR5) driven by the REAL SDK Client
 * over StreamableHTTPClientTransport, its `fetch` bound to the route
 * handlers (no network), through the real key auth, precheck, rate limiter,
 * dispatchAgentTool and request log, over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST, GET, DELETE } = await import("./route");
const { GET: restListTools } = await import("@/app/api/v1/tools/route");
const { mintApiKey } = await import("@/lib/api/keys");
const { agentCallable } = await import("@/lib/api/agent-dispatch");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");

let key: string;
let keyId: string;
let keySeq = 0;
function mintKey(scopes: string[], mode: "live" | "test" = "live") {
  const m = mintApiKey(mode);
  keyId = `k${++keySeq}`;
  mem.seed(`subAccounts/sa1/apiKeys/${keyId}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "Agent key", mode,
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes, revokedAt: null, createdAt: new Date(),
  });
  return m.rawKey;
}
const URL_ = "http://localhost/api/mcp";
const routeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.method === "POST") return POST(req);
  return req.method === "GET" ? GET() : DELETE();
}) as typeof fetch;
const connect = async (bearer = key) => {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: routeFetch,
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    })
  );
  return client;
};
const rawPost = (body: unknown, bearer = key) =>
  POST(new Request(URL_, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  }));
const textOf = (r: unknown) =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
const settle = () => new Promise((r) => setTimeout(r, 10));
const logs = (path: string) => mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.path === path);

const outboundExecute = vi.fn(async () => ({ resultText: "sent" }));
const outbound: AiSuiteCapability = {
  name: "__mcp_outbound",
  level: "sub-account",
  requiredRole: "subAccountMember",
  approval: "outbound",
  menuLabel: "fixture",
  description: "Send a fixture message",
  parameters: { type: "object", properties: { body: { type: "string" } } },
  validate: (raw) => ({ ok: true, args: (raw ?? {}) as Record<string, unknown> }),
  summarize: (args) => `Send “${args.body}”`,
  preview: async (_ctx, args) => ({ rows: [{ label: "Body", value: String(args.body) }], pinned: { to: "+27820009999" } }),
  approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
  execute: outboundExecute,
};

beforeEach(() => {
  mem.clear();
  outboundExecute.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Private", email: "ann@private.io" });
  mem.seed("contacts/c2", { agencyId: "ag1", subAccountId: "sa2", name: "Ann Other", email: "ann@other.io" });
  key = mintKey(["agent"]);
  AI_SUITE_CAPABILITIES.push(outbound);
});
afterEach(() => {
  AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(outbound), 1);
});

describe("tools/list", () => {
  it("is exactly the agent-callable set, with the registry schema and readOnlyHint on reads", async () => {
    const { tools } = await (await connect()).listTools();
    const expected = AI_SUITE_CAPABILITIES.filter(agentCallable);
    expect(tools.map((t) => t.name)).toEqual(expected.map((c) => c.name));
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["find_contacts", "create_contact", "__mcp_outbound"]));
    expect(tools.map((t) => t.name)).not.toContain("create_webhook");
    for (const c of expected) {
      const t = tools.find((x) => x.name === c.name)!;
      expect(t.inputSchema).toEqual(c.parameters);
      expect(t.annotations?.readOnlyHint === true).toBe(c.readonly === true);
    }
  });

  it("matches GET /api/v1/tools tool for tool", async () => {
    const { tools } = await (await connect()).listTools();
    const rest = (await (await restListTools(
      new Request("http://localhost/api/v1/tools", { headers: { authorization: `Bearer ${key}` } }),
      { params: Promise.resolve({}) }
    )).json()) as { tools: Array<{ name: string; description: string; parameters: unknown; readOnly: boolean; approval?: string; approvalWhen?: string }> };
    expect(tools.map((t) => ({
      name: t.name, description: t.description, parameters: t.inputSchema,
      readOnly: t.annotations?.readOnlyHint === true, approval: t._meta?.approval, approvalWhen: t._meta?.approvalWhen,
    }))).toEqual(rest.tools.map(({ name, description, parameters, readOnly, approval, approvalWhen }) => ({ name, description, parameters, readOnly, approval, approvalWhen })));
    expect(tools.find((t) => t.name === "set_bot_mode")?._meta).toEqual({ approval: "outbound", approvalWhen: "mode≠off" });
    expect(rest.tools.find((t) => t.name === "set_bot_mode")).toMatchObject({ approval: "outbound", approvalWhen: "mode≠off" });
    expect(tools.find((t) => t.name === "__mcp_outbound")?._meta).toEqual({ approval: "outbound" });
  });
});

describe("tools/call", () => {
  it("find_contacts returns sa1's contact only, and neither its args nor its result reach the log", async () => {
    const r = await (await connect()).callTool({ name: "find_contacts", arguments: { query: "ann" } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Ann Private");
    expect(textOf(r)).not.toMatch(/Ann Other|ann@other\.io/);
    await settle();
    const [log] = logs("/api/mcp#find_contacts");
    expect(log).toMatchObject({ responseStatus: 200, requestBody: "", responseBody: "" });
    expect(JSON.stringify(log)).not.toMatch(/Ann Private|ann@private\.io/);
  });

  it("a write returns its result text and is logged with its body", async () => {
    const r = await (await connect()).callTool({ name: "create_contact", arguments: { name: "Mcp Contact" } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Mcp Contact");
    await settle();
    expect(String(logs("/api/mcp#create_contact")[0]!.responseBody)).toContain("Mcp Contact");
  });

  it("an approval capability is queued as a proposal: id, summary, preview — never pinned or rev; execute never called", async () => {
    const r = await (await connect()).callTool({ name: "__mcp_outbound", arguments: { body: "hello" } });
    expect(r.isError).toBeFalsy();
    const { proposal } = r.structuredContent as { proposal: { id: string; summary: string; preview: unknown } };
    expect(proposal.id).toEqual(expect.any(String));
    expect(proposal.summary).toBe("Send “hello”");
    expect(proposal.preview).toEqual([{ label: "Body", value: "hello" }]);
    expect(textOf(r)).toContain(proposal.id);
    expect(JSON.stringify(r)).not.toMatch(/\+27820009999|pinned|"rev"/);
    expect(mem.read(`agentProposals/${proposal.id}`)).toMatchObject({ status: "pending" });
    expect(outboundExecute).not.toHaveBeenCalled();
  });

  it("a caller-supplied tool name cannot forge a log line", async () => {
    await (await connect()).callTool({ name: "x\nFAKE\u2028y", arguments: {} });
    await settle();
    const paths = mem.list("subAccounts/sa1/apiRequestLogs").map((l) => String(l.path));
    expect(paths).toContain("/api/mcp#x?FAKE?y");
    expect(paths.some((p) => /[\n\u2028]/.test(p))).toBe(false);
  });

  it("a capped read carries truncated: true — in MCP structuredContent and the REST body alike", async () => {
    for (let i = 0; i < 501; i++) mem.seed(`companies/bulk${i}`, { subAccountId: "sa1", agencyId: "ag1", name: `Bulk ${i}` });
    const r = await (await connect()).callTool({ name: "list_companies", arguments: {} });
    expect(r.structuredContent).toMatchObject({ truncated: true });
    const { POST: restCall } = await import("@/app/api/v1/tools/[name]/route");
    const res = await restCall(
      new Request("http://localhost/api/v1/tools/list_companies", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}",
      }),
      { params: Promise.resolve({ name: "list_companies" }) }
    );
    expect(await res.json()).toMatchObject({ truncated: true });
  });

  it("a refusal is an isError result with its code", async () => {
    const r = await (await connect()).callTool({ name: "create_webhook", arguments: {} });
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: "not_available" } } });
  });

});

describe("HTTP-level refusals", () => {
  it("a bad bearer → 401", async () => {
    const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "lsk_live_nope");
    expect(res.status).toBe(401);
    await expect(connect("lsk_live_nope")).rejects.toMatchObject({ code: 401 });
  });

  it("an admin-scoped key → 403 insufficient_scope", async () => {
    key = mintKey(["admin"]);
    const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "insufficient_scope" } });
  });

  it("a test-mode key is refused", async () => {
    key = mintKey(["agent"], "test");
    const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "test_mode_unsupported" } });
  });

  it("the Agent API gate is read fresh: flipped off, the next call is a 403", async () => {
    const client = await connect();
    expect((await client.callTool({ name: "find_contacts", arguments: { query: "ann" } })).isError).toBeFalsy();
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    await expect(client.callTool({ name: "find_contacts", arguments: { query: "ann" } })).rejects.toMatchObject({ code: 403 });
    await settle();
    // Logs are fire-and-forget: an earlier test's refusal row can land late.
    expect(logs("/api/mcp").filter((l) => l.keyId === keyId)).toMatchObject([{ responseStatus: 403, errorCode: "agent_api_disabled" }]);
  });

  it("GET and DELETE → 405", async () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});

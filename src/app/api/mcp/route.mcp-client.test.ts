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
const { snapshotRemaining, checkAndCount } = await import("@/lib/api/rate-limit");
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
    )).json()) as { tools: Array<{ name: string; description: string; parameters: unknown; readOnly: boolean }> };
    expect(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema, readOnly: t.annotations?.readOnlyHint === true })))
      .toEqual(rest.tools.map(({ name, description, parameters, readOnly }) => ({ name, description, parameters, readOnly })));
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

  it("an approval capability is queued as a proposal: id + summary, never pinned or rev, execute never called", async () => {
    const r = await (await connect()).callTool({ name: "__mcp_outbound", arguments: { body: "hello" } });
    expect(r.isError).toBeFalsy();
    const { proposal } = r.structuredContent as { proposal: { id: string; summary: string } };
    expect(proposal.id).toEqual(expect.any(String));
    expect(proposal.summary).toBe("Send “hello”");
    expect(textOf(r)).toContain(proposal.id);
    expect(JSON.stringify(r)).not.toMatch(/\+27820009999|pinned|"rev"/);
    expect(mem.read(`agentProposals/${proposal.id}`)).toMatchObject({ status: "pending" });
    expect(outboundExecute).not.toHaveBeenCalled();
  });

  it("a refusal is an isError result with its code", async () => {
    const r = await (await connect()).callTool({ name: "create_webhook", arguments: {} });
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: "not_available" } } });
  });

  it("a 3-call JSON-RPC batch in ONE HTTP request consumes 3 rate-limit tokens", async () => {
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_contacts", arguments: { query: "ann" } } });
    expect((await rawPost(call(0))).status).toBe(200); // opens this key's bucket
    const before = snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining;
    const res = await rawPost([call(1), call(2), call(3)]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(3);
    expect(before - snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining).toBe(3);
  });

  it("a request with no tools/call (tools/list) consumes exactly one token; past the limit it is a v1 429", async () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await rawPost(list)).status).toBe(200); // opens this key's bucket
    const before = snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining;
    expect((await rawPost(list)).status).toBe(200);
    expect(before - snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining).toBe(1);
    while (checkAndCount({ keyId, mode: "live", scope: "agent" }).ok);
    const res = await rawPost(list);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limited", request_id: expect.any(String) },
    });
    await settle();
    expect(logs("/api/mcp").filter((l) => l.keyId === keyId)).toMatchObject([{ responseStatus: 429, errorCode: "rate_limited" }]);
  });

  it("invalid JSON is a JSON-RPC parse error, still charged one token", async () => {
    expect((await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    const before = snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining;
    const res = await POST(new Request(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
    expect(before - snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining).toBe(1);
  });

  it("a body over 4 MiB is a 413, never parsed", async () => {
    const res = await POST(new Request(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: `"${"x".repeat(4 * 1024 * 1024)}"`,
    }));
    expect(res.status).toBe(413);
  });

  it("a call past the per-key limit is an isError rate_limited result, not a run", async () => {
    const client = await connect();
    for (let i = 0; i < 60; i++) checkAndCount({ keyId, mode: "live", scope: "agent" });
    const r = await client.callTool({ name: "create_contact", arguments: { name: "Too Many" } });
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: "rate_limited" } } });
    expect(mem.all().filter((d) => d.path.startsWith("contacts/") && JSON.stringify(d.data).includes("Too Many"))).toEqual([]);
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

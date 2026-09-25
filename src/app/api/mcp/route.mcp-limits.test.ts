import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The MCP route's rate limit and batch rules (AGENT_API_V1_PLAN.md, PR5):
 * every authenticated request pays one token up front, each executed
 * tools/call one more; a batch repeating an id is refused whole. Same
 * harness as route.mcp-client.test.ts.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST, GET, DELETE } = await import("./route");
const { mintApiKey } = await import("@/lib/api/keys");
const { snapshotRemaining, checkAndCount } = await import("@/lib/api/rate-limit");

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
const settle = () => new Promise((r) => setTimeout(r, 10));
const logs = (path: string) => mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.path === path);

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Private", email: "ann@private.io" });
  mem.seed("contacts/c2", { agencyId: "ag1", subAccountId: "sa2", name: "Ann Other", email: "ann@other.io" });
  key = mintKey(["agent"]);
});

const remaining = () => snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining;
const ACCEPT = "application/json, text/event-stream";
const post = (body: string, headers: Record<string, string> = {}) =>
  POST(new Request(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: ACCEPT, ...headers },
    body,
  }));
const call = (id: number | undefined, name = "find_contacts", args: unknown = { query: "ann" }) => ({
  jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: "tools/call", params: { name, arguments: args },
});
const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
/** Tokens a request costs, measured after this key's bucket is open. */
const cost = async (send: () => Promise<Response>) => {
  expect((await rawPost(list(0))).status).toBe(200); // opens the bucket
  const before = remaining();
  const res = await send();
  return { res, tokens: before - remaining() };
};
const contactsNamed = (name: string) =>
  mem.all().filter((d) => d.path.startsWith("contacts/") && JSON.stringify(d.data).includes(name));

describe("one token per request, one more per executed tools/call", () => {
  it("tools/list costs 1", async () => {
    const { res, tokens } = await cost(() => rawPost(list(1)));
    expect(res.status).toBe(200);
    expect(tokens).toBe(1);
  });

  it("a 3-call batch costs 4 and runs all three", async () => {
    const { res, tokens } = await cost(() => rawPost([call(1), call(2), call(3)]));
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(3);
    expect(tokens).toBe(4);
  });

  it.each([
    ["a tools/call notification (no id)", () => rawPost(call(undefined, "create_contact", { name: "Notified" }))],
    ["a tools/call with invalid params", () => rawPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })],
    ["a transport 406 (no Accept)", () => post(JSON.stringify(call(1, "create_contact", { name: "Notified" })), { accept: "application/json" })],
    ["invalid JSON", () => post("{not json")],
  ])("%s runs nothing and still costs 1", async (_label, send) => {
    const { res, tokens } = await cost(send);
    expect(tokens).toBe(1);
    expect(res.status).not.toBe(429);
    expect(contactsNamed("Notified")).toEqual([]);
  });

  it("the token is charged before the precheck: a request refused by the gate still costs 1", async () => {
    const { tokens } = await cost(async () => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
      const res = await rawPost(list(1));
      expect(res.status).toBe(403);
      return res;
    });
    expect(tokens).toBe(1);
  });

  it("1 tools/call notification + 99 tools/list in one batch costs 1", async () => {
    const batch = [call(undefined), ...Array.from({ length: 99 }, (_, i) => list(i + 1))];
    const { res, tokens } = await cost(() => rawPost(batch));
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(99);
    expect(tokens).toBe(1);
  });
});

describe("refused before any message runs", () => {
  it("an exhausted key gets the v1 429 with X-RateLimit-* headers, and the tools/call never runs", async () => {
    while (checkAndCount({ keyId, mode: "live", scope: "agent" }).ok);
    const res = await rawPost(call(1, "create_contact", { name: "Too Many" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(res.headers.get("x-ratelimit-limit")).toBe("60");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(res.headers.get("x-ratelimit-reset")).toMatch(/^\d+$/);
    expect(res.headers.get("x-ratelimit-window")).toBe("minute");
    expect(await res.json()).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limited", request_id: expect.any(String) },
    });
    expect(contactsNamed("Too Many")).toEqual([]);
    await settle();
    expect(logs("/api/mcp").filter((l) => l.keyId === keyId)).toMatchObject([{ responseStatus: 429, errorCode: "rate_limited" }]);
  });

  it("a batch repeating a request id is a JSON-RPC -32600, and none of it runs", async () => {
    const dup = () => call(7, "create_contact", { name: "Dup Seven" });
    const res = await rawPost([dup(), dup(), dup()]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    expect(contactsNamed("Dup Seven")).toEqual([]);
  });

  it("a body over 4 MiB is a 413, never parsed", async () => {
    const res = await post(`"${"x".repeat(4 * 1024 * 1024)}"`);
    expect(res.status).toBe(413);
  });

  it("a call past the limit inside a request that got its token is an isError rate_limited result, not a run", async () => {
    const client = await connect();
    while (remaining() > 1) checkAndCount({ keyId, mode: "live", scope: "agent" });
    const r = await client.callTool({ name: "create_contact", arguments: { name: "Too Many" } });
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: "rate_limited" } } });
    expect(contactsNamed("Too Many")).toEqual([]);
  });
});

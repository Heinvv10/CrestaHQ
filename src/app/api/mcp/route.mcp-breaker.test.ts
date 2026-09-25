import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The breaker's PR #267 repros, as regressions: log amplification from an
 * exhausted key, a write whose args can't be serialised, unknown names'
 * args in the log, and the SDK's raw validation text. Same harness as
 * route.mcp-client.test.ts.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST } = await import("./route");
const { POST: restCall } = await import("@/app/api/v1/tools/[name]/route");
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

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Private", email: "ann@private.io" });
  mem.seed("contacts/c2", { agencyId: "ag1", subAccountId: "sa2", name: "Ann Other", email: "ann@other.io" });
  key = mintKey(["agent"]);
});

const remaining = () => snapshotRemaining({ keyId, mode: "live", scope: "agent" }).remaining;
const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const keyLogs = () => mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.keyId === keyId);
const contactsNamed = (name: string) =>
  mem.all().filter((d) => d.path.startsWith("contacts/") && JSON.stringify(d.data).includes(name));
/** 200k-deep JSON, built as text: JSON.stringify itself overflows on it. */
const DEEP = `${'{"a":'.repeat(200_000)}1${"}".repeat(200_000)}`;
const rawText = (text: string) =>
  POST(new Request(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: text,
  }));

describe("REPRO 2: an exhausted key cannot amplify one request into many log rows", () => {
  it("3 exhausted-key batches of 100 tools/call write at most 3 log rows", async () => {
    while (checkAndCount({ keyId, mode: "live", scope: "agent" }).ok);
    const batch = Array.from({ length: 100 }, (_, i) => call(i + 1, "find_contacts", { query: "ann" }));
    for (let n = 0; n < 3; n++) expect((await rawPost(batch)).status).toBe(429);
    await settle();
    expect(keyLogs().length).toBeLessThanOrEqual(3);
  });

  it("calls rate-limited inside a batch collapse into ONE summary row with their count", async () => {
    while (remaining() > 4) checkAndCount({ keyId, mode: "live", scope: "agent" });
    const batch = Array.from({ length: 100 }, (_, i) => call(i + 1, "find_contacts", { query: "ann" }));
    const res = await rawPost(batch); // the request token (covering call 1) + 3 more calls run, 96 refused
    expect(res.status).toBe(200);
    await settle();
    const rows = keyLogs();
    const summary = rows.filter((l) => l.path === "/api/mcp");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ responseStatus: 429, errorCode: "rate_limited" });
    expect(JSON.parse(String(summary[0]!.responseBody))).toEqual({ rateLimitedCalls: 96 });
    expect(rows.filter((l) => l.path === "/api/mcp#find_contacts")).toHaveLength(4);
    expect(rows).toHaveLength(5); // 4 calls + 1 summary: no row per refused call
  });
});

describe("REPRO 3: a write whose raw args can't be serialised still returns its normal result", () => {
  it("MCP: 200k-nested args → the normal result, one contact, one log row", async () => {
    const res = await rawText(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_contact","arguments":{"name":"Deep Nest","junk":${DEEP}}}}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Added contact");
    expect(text).not.toMatch(/call stack/i);
    expect(contactsNamed("Deep Nest")).toHaveLength(1);
    await settle();
    const rows = keyLogs().filter((l) => l.path === "/api/mcp#create_contact");
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.requestBody)).toContain("Deep Nest"); // the validated args, not the raw
    expect(String(rows[0]!.requestBody)).not.toContain('"junk"');
  });

  it("a log that throws never changes the result", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = await import("@/lib/api/logs");
    const spy = vi.spyOn(logs, "captureRequestLog").mockImplementation(() => {
      throw new Error("log boom");
    });
    const res = await rawPost(call(1, "create_contact", { name: "Log Boom" }));
    spy.mockRestore();
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Added contact");
    expect(text).not.toContain("log boom");
    expect(err).toHaveBeenCalledWith("[api/mcp] request log failed", expect.any(Error));
    err.mockRestore();
  });

  it("REST: the same args → 200, one contact, one log row", async () => {
    const res = await restCall(
      new Request("http://localhost/api/v1/tools/create_contact", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: `{"name":"Deep Rest","junk":${DEEP}}`,
      }),
      { params: Promise.resolve({ name: "create_contact" }) }
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("Added contact");
    expect(contactsNamed("Deep Rest")).toHaveLength(1);
    await settle();
    expect(keyLogs().filter((l) => l.path === "/api/v1/tools/create_contact")).toHaveLength(1);
  });
});

describe("unknown or misspelled names log no bodies", () => {
  it("MCP", async () => {
    await rawPost(call(1, "find_contact", { query: "ann@private.io" }));
    await settle();
    const rows = keyLogs().filter((l) => l.path === "/api/mcp#find_contact");
    expect(rows).toMatchObject([{ requestBody: "", responseBody: "" }]);
    expect(JSON.stringify(rows)).not.toContain("ann@private.io");
  });

  it("REST", async () => {
    await restCall(
      new Request("http://localhost/api/v1/tools/find_contact", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "ann@private.io" }),
      }),
      { params: Promise.resolve({ name: "find_contact" }) }
    );
    await settle();
    const rows = keyLogs().filter((l) => l.path === "/api/v1/tools/find_contact");
    expect(rows).toMatchObject([{ requestBody: "", responseBody: "" }]);
    expect(JSON.stringify(rows)).not.toContain("ann@private.io");
  });
});

it("a tools/call with no params gets a generic JSON-RPC error, not the SDK's validation dump", async () => {
  const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/call" });
  const body = (await res.json()) as { error: { code: number; message: string; data?: unknown } };
  expect(body.error).toEqual({ code: -32602, message: "Invalid tool call: check the tool name and arguments." });
});

it("an SDK error on another method gets a generic \"Invalid request.\"", async () => {
  const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: 5 } });
  const body = (await res.json()) as { error: { code: number; message: string } };
  expect(body.error).toEqual({ code: -32600, message: "Invalid request." });
});

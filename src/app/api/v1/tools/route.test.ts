import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * The Agent API's REST mirror (AGENT_API_V1_PLAN.md, PR4), through the REAL
 * withApiAuth — key lookup + hash, scope, rate limit, idempotency, request
 * log — and the real dispatchAgentTool, over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { GET } = await import("./route");
const { POST } = await import("./[name]/route");
const { mintApiKey } = await import("@/lib/api/keys");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");

let key: string;
let keySeq = 0;
function mintKey(scopes: string[], mode: "live" | "test" = "live") {
  const m = mintApiKey(mode);
  mem.seed(`subAccounts/sa1/apiKeys/k${++keySeq}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "Agent key", mode,
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes, revokedAt: null, createdAt: new Date(),
  });
  return m.rawKey;
}
const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
const listTools = () => GET(new Request("http://localhost/api/v1/tools", { headers: headers() }), { params: undefined });
const call = (name: string, body: unknown, extra: Record<string, string> = {}) =>
  POST(
    new Request(`http://localhost/api/v1/tools/${name}`, {
      method: "POST",
      headers: { ...headers(extra), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) }
  );
const settle = () => new Promise((r) => setTimeout(r, 10));
// Logs are written fire-and-forget; one from a previous test can land after
// the store was cleared, so every read filters by path.
const logs = (path: string) => mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.path === path);

const outbound: AiSuiteCapability = {
  name: "__rest_outbound",
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
  execute: vi.fn(async () => ({ resultText: "sent" })),
};

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Private", email: "ann@private.io" });
  key = mintKey(["agent"]);
  AI_SUITE_CAPABILITIES.push(outbound);
});
afterEach(() => {
  AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(outbound), 1);
});

describe("GET /api/v1/tools", () => {
  it("lists the agent-surfaced tools with their schemas, never a chat-only one", async () => {
    const res = await listTools();
    expect(res.status).toBe(200);
    const { tools } = (await res.json()) as { tools: Array<{ name: string; readOnly: boolean; approval?: string }> };
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["find_contacts", "create_contact", "__rest_outbound"]));
    expect(names).not.toContain("create_webhook");
    expect(names).not.toContain("list_sub_accounts");
    expect(tools.find((t) => t.name === "find_contacts")).toMatchObject({ readOnly: true });
    expect(tools.find((t) => t.name === "__rest_outbound")).toMatchObject({ readOnly: false, approval: "outbound" });
  });

  it("an admin key → 403 insufficient_scope", async () => {
    key = mintKey(["admin"]);
    const res = await listTools();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "insufficient_scope" } });
  });

  it("the Agent API gate is re-read per request: flipped off, the next call is 403", async () => {
    expect((await listTools()).status).toBe(200);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    const res = await listTools();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "agent_api_disabled" } });
  });
});

describe("POST /api/v1/tools/{name}", () => {
  it("a read tool → 200 {result}; neither its args nor its result reach the request log", async () => {
    const res = await call("find_contacts", { query: "ann@private.io" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toContain("Ann Private");
    await settle();
    const [log] = logs("/api/v1/tools/find_contacts");
    expect(log).toMatchObject({ responseStatus: 200, requestBody: "", responseBody: "" });
    expect(JSON.stringify(log)).not.toContain("Ann Private");
    expect(JSON.stringify(log)).not.toContain("ann@private.io");
  });

  it("a write tool logs its response normally", async () => {
    const res = await call("create_contact", { name: "Logged Contact" });
    expect(res.status).toBe(200);
    await settle();
    expect(String(logs("/api/v1/tools/create_contact")[0]!.responseBody)).toContain("Logged Contact");
  });

  it("an admin key → 403 insufficient_scope", async () => {
    key = mintKey(["admin"]);
    const res = await call("find_contacts", { query: "ann" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "insufficient_scope" } });
  });

  it("an unknown tool → the same 404 as a chat-only one", async () => {
    const unknown = await call("no_such_tool", {});
    const chatOnly = await call("create_webhook", {});
    expect(unknown.status).toBe(404);
    expect(chatOnly.status).toBe(404);
    const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, request_id: undefined });
    expect(strip(await unknown.json())).toEqual(strip(await chatOnly.json()));
  });

  it("an approval capability → 202 with the proposal id; never pinned or rev", async () => {
    const res = await call("__rest_outbound", { body: "hi" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { proposal: Record<string, unknown> };
    expect(body.proposal).toEqual({
      id: expect.stringMatching(/^p_/),
      status: "pending",
      summary: "Send “hi”",
      preview: [{ label: "Body", value: "hi" }],
    });
    expect(JSON.stringify(body)).not.toContain("+27820009999");
    expect(body.proposal).not.toHaveProperty("rev");
    expect(JSON.stringify(body)).not.toContain('"rev"');
    expect(outbound.execute).not.toHaveBeenCalled();
  });

  it("an Idempotency-Key replay → the same 202 and one proposal", async () => {
    const first = await call("__rest_outbound", { body: "hi" }, { "idempotency-key": "retry-1" });
    const second = await call("__rest_outbound", { body: "hi" }, { "idempotency-key": "retry-1" });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    expect(mem.list("agentProposals")).toHaveLength(1);
    expect(mem.list("subAccounts/sa1/apiIdempotency").length).toBeGreaterThan(0);
  });

  it("a read tool ignores Idempotency-Key and writes no apiIdempotency doc; a write still caches", async () => {
    expect((await call("find_contacts", { query: "ann" }, { "idempotency-key": "read-1" })).status).toBe(200);
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
    expect((await call("create_contact", { name: "Cached" }, { "idempotency-key": "write-1" })).status).toBe(200);
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toHaveLength(1);
  });

  it("parallel reads under one Idempotency-Key never reserve it: none is refused as in progress", async () => {
    const results = await Promise.all([1, 2, 3].map(() => call("find_contacts", { query: "ann" }, { "idempotency-key": "read-par" })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it("the Agent API gate is re-read per request: flipped off, the next call is 403", async () => {
    expect((await call("find_contacts", { query: "ann" })).status).toBe(200);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    const res = await call("find_contacts", { query: "ann" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "agent_api_disabled" } });
  });

  it("one POST consumes one token of the agent scope's per-minute budget", async () => {
    const res = await call("find_contacts", { query: "ann" });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
  });
});

describe("no oracle, one predicate", () => {
  it("a chat-only read tool and an unknown name behave identically under a repeated Idempotency-Key", async () => {
    const run = async (name: string, k: string) => {
      const a = await call(name, {}, { "idempotency-key": k });
      const b = await call(name, {}, { "idempotency-key": k });
      const strip = async (r: Response) => ({ status: r.status, ...((await r.json()) as { error: object }).error, request_id: undefined });
      return [await strip(a), await strip(b)];
    };
    expect(await run("my_access", "oracle-1")).toEqual(await run("no_such_tool", "oracle-2"));
    // An INVALID key: a real read tool skips idempotency entirely, so if a
    // chat-only read name were treated as one it would answer differently.
    const invalid = async (name: string) => {
      const r = await call(name, {}, { "idempotency-key": "not a valid key!" });
      return { status: r.status, ...((await r.json()) as { error: object }).error, request_id: undefined };
    };
    expect(await invalid("my_access")).toEqual(await invalid("no_such_tool"));
    // Treated alike: both a 404 refusal, so neither is cached.
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
  });

  it("an agency-level tool any role satisfies is neither listed nor callable", async () => {
    const agencyFixture = { ...outbound, name: "__rest_agency", level: "agency" as const, approval: undefined, readonly: true };
    AI_SUITE_CAPABILITIES.push(agencyFixture);
    try {
      const listed = ((await (await listTools()).json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(listed).not.toContain("__rest_agency");
      expect((await call("__rest_agency", {})).status).toBe(404);
    } finally {
      AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(agencyFixture), 1);
    }
  });

  it("parity: GET /tools lists exactly the names dispatch accepts, over the whole registry", async () => {
    const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
    const auth = {
      agencyId: "ag1", subAccountId: "sa1", keyId: `k${keySeq}`, keyPrefix: "x", keyName: "k", mode: "live" as const,
      scopes: ["agent" as const], enrolmentCapPerHour: 50, requestId: "r", apiVersion: "2026-01-01",
    };
    const accepted: string[] = [];
    for (const cap of AI_SUITE_CAPABILITIES) {
      const r = await dispatchAgentTool(auth, cap.name, {});
      if (!("code" in r) || r.code !== "not_available") accepted.push(cap.name);
    }
    const listed = ((await (await listTools()).json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(listed.sort()).toEqual(accepted.sort());
  });
});

describe("which outcomes are cached", () => {
  it("a refusal is never cached; a 409 outcome_unknown is", async () => {
    expect((await call("create_contact", {}, { "idempotency-key": "bad-args" })).status).toBe(400);
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
    const first = (await (await call("__rest_outbound", { body: "hi" })).json()) as { proposal: { id: string } };
    mem.seed(`agentProposals/${first.proposal.id}`, { ...mem.read(`agentProposals/${first.proposal.id}`), status: "unsettled" });
    const unknown = await call("__rest_outbound", { body: "hi" }, { "idempotency-key": "u1" });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toHaveLength(1);
  });
});

describe("the gate and test mode run before any cached reply", () => {
  it("a write cached under w1, then the gate switched off: replaying w1 is 403, nothing new written", async () => {
    expect((await call("create_contact", { name: "Once" }, { "idempotency-key": "w1" })).status).toBe(200);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    const replay = await call("create_contact", { name: "Once" }, { "idempotency-key": "w1" });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ error: { code: "agent_api_disabled" } });
    expect(mem.list("contacts").filter((c) => c.name === "Once")).toHaveLength(1);
  });

  it("a 403 agent_api_disabled is never cached: gate off → 403 → gate on → a new key works", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    expect((await call("create_contact", { name: "Later" }, { "idempotency-key": "n1" })).status).toBe(403);
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: true });
    expect((await call("create_contact", { name: "Later" }, { "idempotency-key": "n2" })).status).toBe(200);
  });

  it("GET /tools and POST refuse a test-mode key with test_mode_unsupported", async () => {
    key = mintKey(["agent"], "test");
    for (const res of [await listTools(), await call("find_contacts", { query: "ann" })]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "test_mode_unsupported" } });
    }
  });
});

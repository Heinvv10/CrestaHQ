import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * POST /api/v1/tools/{name} for an agency key, through the REAL withApiAuth
 * (key hash, kill switch, precheck, idempotency, request log) and the real
 * handler, opted in with allowAgencyKey as the route will be in A3b. Logs:
 * under the target only once reach let the call through — every outcome
 * after that, a refusal or a throw included — else under the agency, as MCP.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { CALL_AGENT_TOOL_OPTIONS, callAgentTool } = await import("./agent-tools-call");
const { mintApiKey } = await import("./keys");
const { apiOk } = await import("./responses");
const { AI_SUITE_CAPABILITIES, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");

const POST = withApiAuth<{ name: string }>(callAgentTool, { ...CALL_AGENT_TOOL_OPTIONS, allowAgencyKey: true });
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
let key: string;

const thrower: AiSuiteCapability = {
  name: "__rest_thrower",
  level: "sub-account",
  requiredRole: "subAccountMember",
  readonly: true,
  menuLabel: "fixture",
  description: "fixture",
  parameters: { type: "object", properties: {} },
  validate: () => ({ ok: true, args: {} }),
  summarize: () => "fixture",
  execute: async () => {
    throw new CapabilityUserError("That record is not here.");
  },
};

const call = (name: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://localhost/api/v1/tools/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );
const settle = () => new Promise((r) => setTimeout(r, 10));
const logs = () => mem.all().map((d) => d.path).filter((p) => p.includes("/apiRequestLogs/"));
const logsUnder = (prefix: string) => logs().filter((p) => p.startsWith(prefix));

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", ...ON });
  mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", ...ON });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann One", createdAt: new Date() });
  const m = mintApiKey("live");
  mem.seed("agencies/ag1/apiKeys/ak1", {
    agencyId: "ag1", subAccountId: null, createdByUid: "owner1", name: "Agency key", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["agent"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
  AI_SUITE_CAPABILITIES.push(thrower);
});
afterEach(async () => {
  AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(thrower), 1);
  await settle();
});

describe("request logs by key level", () => {
  it("a reached call logs under its target only", async () => {
    const res = await call("find_contacts", { subAccountId: "sa1", query: "ann" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toContain("Ann One");
    await settle();
    expect(logs()).toHaveLength(1);
    expect(logsUnder("subAccounts/sa1/apiRequestLogs/")).toHaveLength(1);
  });

  it.each([
    ["invalid args", "find_contacts", { subAccountId: "sa1" }],
    ["a thrown CapabilityUserError", "__rest_thrower", { subAccountId: "sa1" }],
  ])("past reach, %s still logs under the target", async (_label, name, body) => {
    const res = await call(name, body);
    expect(res.status).toBe(400);
    await settle();
    expect(logs()).toHaveLength(1);
    expect(logsUnder("subAccounts/sa1/apiRequestLogs/")).toHaveLength(1);
  });

  it.each([
    ["a refusal at reach", "find_contacts", { subAccountId: "sa2", query: "ann" }, 404],
    ["an agency-level call", "list_sub_accounts", {}, 200],
  ])("%s logs under the agency only", async (_label, name, body, status) => {
    expect((await call(name, body)).status).toBe(status);
    await settle();
    expect(logsUnder("subAccounts/")).toEqual([]);
    expect(logsUnder("agencies/ag1/apiRequestLogs/")).toHaveLength(1);
  });
});

describe("logUnder is structural", () => {
  it("a sub-account key's handler naming another sub-account still logs under its own", async () => {
    const m = mintApiKey("live");
    mem.seed("subAccounts/sa1/apiKeys/k1", {
      agencyId: "ag1", subAccountId: "sa1", name: "Sub key", mode: "live",
      prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["agent"], revokedAt: null, createdAt: new Date(),
    });
    key = m.rawKey;
    const route = withApiAuth(
      async ({ ctx, logUnder }) => {
        logUnder("sa2");
        return apiOk(ctx, {});
      },
      { requireScope: "agent" },
    );
    const res = await route(new Request("http://localhost/x", { headers: { authorization: `Bearer ${key}` } }), {});
    expect(res.status).toBe(200);
    await settle();
    expect(logs()).toHaveLength(1);
    expect(logsUnder("subAccounts/sa1/apiRequestLogs/")).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("an agency-level read is never replayed: a gate switch shows on the next call", async () => {
    const first = (await (await call("list_sub_accounts", {}, { "idempotency-key": "same" })).json()) as { result: string };
    expect(first.result).toContain("id: sa1.");
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", ...ON, agentApiEnabledByAgency: false });
    const second = (await (await call("list_sub_accounts", {}, { "idempotency-key": "same" })).json()) as { result: string };
    expect(second.result).not.toContain("id: sa1.");
    expect(mem.all().filter((d) => d.path.includes("/apiIdempotency/"))).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Agency-key reach through the REAL route handlers (folded in from the A3b
 * breaker): every sub-account it may not act in gets one indistinguishable
 * 404 (status, body minus request_id, header names); an idempotent replay
 * never outlives the target's gate or the agency switch; a JSON-RPC batch
 * reaches only reachable targets; nothing lands under subAccounts/null.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST: restCall } = await import("@/app/api/v1/tools/[name]/route");
const { POST: mcp } = await import("@/app/api/mcp/route");
const { mintApiKey } = await import("./keys");

const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
let agencyKey: string;

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
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", timezone: "UTC", ...ON });
  mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", timezone: "UTC", ...ON });
  mem.seed("subAccounts/sa5", { agencyId: "ag1", name: "Five", timezone: "UTC", ...ON, apiAccessEnabledByAgency: false });
  mem.seed("subAccounts/sa6", { agencyId: "ag1", name: "Six", timezone: "UTC", ...ON, agentApiEnabledByAgency: false });
  for (const sa of ["sa1", "sa2", "sa5", "sa6"]) {
    mem.seed(`contacts/c_${sa}`, { agencyId: sa === "sa2" ? "ag2" : "ag1", subAccountId: sa, name: `Ann ${sa}`, createdAt: new Date() });
  }
  agencyKey = seedKey("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", subAccountId: null, createdByUid: "owner1" });
});

const headers = (key: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});
const rest = (name: string, body: unknown, extra: Record<string, string> = {}) =>
  restCall(
    new Request(`http://localhost/api/v1/tools/${name}`, { method: "POST", headers: headers(agencyKey, extra), body: JSON.stringify(body) }),
    { params: Promise.resolve({ name }) },
  );
const mcpPost = (message: unknown) =>
  mcp(new Request("http://localhost/api/mcp", { method: "POST", headers: headers(agencyKey), body: JSON.stringify(message) }));
const shape = async (res: Response) => {
  const body = (await res.json()) as { error: Record<string, unknown> };
  delete body.error.request_id;
  const names = [...res.headers.keys()].filter((h) => h !== "x-request-id").sort();
  return { status: res.status, body, names };
};
const settle = () => new Promise((r) => setTimeout(r, 10));
const under = (prefix: string) => mem.all().filter((d) => d.path.startsWith(prefix));

const UNREACHABLE: Array<[string, unknown]> = [
  ["another agency's", "sa2"],
  ["apiAccess off", "sa5"],
  ["agentApi off", "sa6"],
  ["made-up", "sa_madeup"],
  ["leading space", " sa1"],
  ["upper case", "SA1"],
  ["a path", "sa1/x"],
  ["null", null],
  ["a number", 1],
  ["empty", ""],
];

describe("one indistinguishable 404 for every unreachable target", () => {
  it("REST find_contacts: status, body minus request_id and header names are identical", async () => {
    const shapes = [];
    for (const [, id] of UNREACHABLE) shapes.push(await shape(await rest("find_contacts", { subAccountId: id, query: "ann" })));
    expect(shapes[0]).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    for (const [i, s] of shapes.entries()) expect(s, UNREACHABLE[i]![0]).toEqual(shapes[0]);
  });

  it("REST create_contact (a write, idempotency on): the same", async () => {
    const shapes = [];
    for (const [, id] of UNREACHABLE) {
      shapes.push(await shape(await rest("create_contact", { subAccountId: id, name: "Zed" }, { "idempotency-key": `k-${String(id)}` })));
    }
    for (const [i, s] of shapes.entries()) expect(s, UNREACHABLE[i]![0]).toEqual(shapes[0]);
    expect(mem.all().filter((d) => d.path.startsWith("contacts/") && (d.data as { name?: string }).name === "Zed")).toEqual([]);
  });

  it("MCP tools/call: identical results", async () => {
    const results = [];
    for (const [, id] of UNREACHABLE) {
      const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_contacts", arguments: { subAccountId: id, query: "ann" } } });
      results.push(((await res.json()) as { result: unknown }).result);
    }
    for (const [i, r] of results.entries()) expect(r, UNREACHABLE[i]![0]).toEqual(results[0]);
    expect(under("agencies/ag1/agentCalls")).toEqual([]);
  });
});

describe("an idempotent replay never outlives the target's reach or the agency switch", () => {
  const create = () => rest("create_contact", { subAccountId: "sa1", name: "Idem" }, { "idempotency-key": "idem-1" });

  it("target's agentApi gate switched off → the replay is the 404, not the cached 200", async () => {
    expect((await create()).status).toBe(200);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    const res = await create();
    expect(res.status).toBe(404);
  });

  it("target moved to another agency → 404", async () => {
    expect((await create()).status).toBe(200);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agencyId: "ag2" });
    expect((await create()).status).toBe(404);
  });

  it("agency switch off → 403, not the cached 200", async () => {
    expect((await create()).status).toBe(200);
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    expect((await create()).status).toBe(403);
  });

  it("minter demoted → refused, not the cached 200", async () => {
    expect((await create()).status).toBe(200);
    mem.seed("agencies/ag1/agencyMembers/owner1", { role: "admin", status: "active" });
    expect((await create()).status).toBe(401);
  });

  it("same Idempotency-Key aimed at another reachable target → collision, never sa1's cached body", async () => {
    mem.seed("subAccounts/sa4", { agencyId: "ag1", name: "Four", timezone: "UTC", ...ON });
    expect((await create()).status).toBe(200);
    const res = await rest("create_contact", { subAccountId: "sa4", name: "Idem" }, { "idempotency-key": "idem-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("idempotency_collision");
  });
});

describe("a JSON-RPC batch", () => {
  it("reaches only reachable targets; one agent.call row per reached call; nothing under subAccounts/null", async () => {
    const call = (id: number, sa: unknown) => ({
      jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_contacts", arguments: { subAccountId: sa, query: "ann" } },
    });
    const res = await mcpPost([call(1, "sa1"), call(2, "sa2"), call(3, "sa6"), call(4, "sa1")]);
    const out = (await res.json()) as Array<{ id: number; result: { isError?: boolean; content: Array<{ text: string }> } }>;
    const byId = Object.fromEntries(out.map((m) => [m.id, m.result]));
    expect(byId[1]!.content[0]!.text).toContain("Ann sa1");
    expect(byId[2]!.isError).toBe(true);
    expect(byId[3]!.isError).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/Ann sa[256]/);
    expect(under("agencies/ag1/agentCalls").map((d) => (d.data as { subAccountId: string }).subAccountId)).toEqual(["sa1", "sa1"]);
    await settle();
    expect(under("subAccounts/null")).toEqual([]);
    expect(under("subAccounts/sa2/")).toEqual([]);
    expect(under("subAccounts/sa6/")).toEqual([]);
  });
});

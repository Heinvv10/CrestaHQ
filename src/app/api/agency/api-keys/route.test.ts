import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Agency API key management (AGENCY_AGENT_API_PLAN.md A2): mint is
 * agent-scope + live only and refused while the agency's Agent API switch is
 * off; GET and the mint response list the sub-accounts the key reaches (both
 * reach gates on, this agency only); revoke is scoped to the caller's agency.
 * Real routes over an in-memory Firestore; the minted key is then presented
 * to the real auth path.
 */

const mem = createMemoryFirestore();
const caller = vi.hoisted(() => ({ value: { uid: "owner1", agencyId: "ag1" } as unknown }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireAgencyOwnerAny: async () => caller.value,
}));

const { GET, POST } = await import("./route");
const { DELETE } = await import("./[keyId]/route");
const { POST: mcp } = await import("@/app/api/mcp/route");

const mint = (body: unknown) =>
  POST(new Request("http://x/api/agency/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const revoke = (keyId: string) =>
  DELETE(new Request(`http://x/api/agency/api-keys/${keyId}`, { method: "DELETE" }), {
    params: Promise.resolve({ keyId }),
  });
const callMcp = (key: string) =>
  mcp(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
const keyDocs = () => mem.all().filter((d) => d.path.includes("/apiKeys/"));

type MintBody = { key: { id: string; secret?: string; scopes: string[]; mode: string; hashedSecret?: unknown }; reach: Array<{ id: string; name: string }> };

beforeEach(() => {
  mem.clear();
  caller.value = { uid: "owner1", agencyId: "ag1" };
  mem.seed("agencies/ag1", { name: "Agency", agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  const both = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
  mem.seed("subAccounts/sa_v", { agencyId: "ag1", name: "Velocity", ...both });
  mem.seed("subAccounts/sa_b", { agencyId: "ag1", name: "Blitz", ...both });
  mem.seed("subAccounts/sa_api_off", { agencyId: "ag1", name: "No API", agentApiEnabledByAgency: true });
  mem.seed("subAccounts/sa_agent_off", { agencyId: "ag1", name: "No Agent", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: false });
  mem.seed("subAccounts/sa_other", { agencyId: "ag2", name: "Other agency", ...both });
});

afterEach(() => {
  expect(mem.all().filter((d) => d.path.startsWith("subAccounts/null"))).toEqual([]);
});

const REACH = [{ id: "sa_b", name: "Blitz" }, { id: "sa_v", name: "Velocity" }];

describe("POST mint", () => {
  it("mints a live agent key under the agency and returns the reach by name", async () => {
    const res = await mint({ name: "Onboarding agent" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintBody;
    expect(body.key.secret).toMatch(/^lsk_live_/);
    expect(body.key).toMatchObject({ scopes: ["agent"], mode: "live" });
    expect(body.key.hashedSecret).toBeUndefined();
    expect(body.reach).toEqual(REACH);
    const docs = keyDocs();
    expect(docs.map((d) => d.path)).toEqual([`agencies/ag1/apiKeys/${body.key.id}`]);
    expect(docs[0]!.data).toMatchObject({ agencyId: "ag1", subAccountId: null, scopes: ["agent"], mode: "live", createdByUid: "owner1" });
  });

  it("the minted key authenticates as an agency key (refused by the transport, not as invalid)", async () => {
    const { key } = (await (await mint({ name: "k" })).json()) as MintBody;
    const res = await callMcp(key.secret!);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agency_key_not_allowed");
  });

  it.each([
    ["agent + admin", { scopes: ["agent", "admin"] }],
    ["admin", { scopes: ["admin"] }],
    ["forms-ingest", { scopes: ["forms-ingest"] }],
    ["an empty scope list", { scopes: [] }],
    ["test mode", { mode: "test" }],
    ["test mode with the agent scope", { mode: "test", scopes: ["agent"] }],
  ])("refuses %s with 400 and writes nothing", async (_label, extra) => {
    const res = await mint({ name: "k", ...extra });
    expect(res.status).toBe(400);
    expect(keyDocs()).toEqual([]);
  });

  it("accepts an explicit live mode and agent scope", async () => {
    expect((await mint({ name: "k", mode: "live", scopes: ["agent"] })).status).toBe(200);
  });

  it("refuses while the agency's Agent API switch is off (403, nothing written)", async () => {
    mem.seed("agencies/ag1", { name: "Agency" });
    const res = await mint({ name: "k" });
    expect(res.status).toBe(403);
    expect(keyDocs()).toEqual([]);
  });

  it("refuses a missing name", async () => {
    expect((await mint({})).status).toBe(400);
    expect(keyDocs()).toEqual([]);
  });

  it("refuses a non-owner (the guard's response passes through)", async () => {
    const { NextResponse } = await import("next/server");
    caller.value = NextResponse.json({ error: "Agency owner only" }, { status: 403 });
    expect((await mint({ name: "k" })).status).toBe(403);
    expect(keyDocs()).toEqual([]);
  });
});

describe("GET", () => {
  it("lists the agency's keys without secrets, and the reach before any mint", async () => {
    const before = (await (await GET(new Request("http://x/api/agency/api-keys"))).json()) as { keys: unknown[]; reach: unknown };
    expect(before).toEqual({ keys: [], reach: REACH });
    await mint({ name: "k" });
    const after = (await (await GET(new Request("http://x/api/agency/api-keys"))).json()) as { keys: Array<Record<string, unknown>> };
    expect(after.keys).toHaveLength(1);
    expect(after.keys[0]).not.toHaveProperty("secret");
    expect(after.keys[0]).not.toHaveProperty("hashedSecret");
  });
});

describe("DELETE revoke", () => {
  it("revokes the caller's own agency key; the key is then refused 401", async () => {
    const { key } = (await (await mint({ name: "k" })).json()) as MintBody;
    expect((await revoke(key.id)).status).toBe(200);
    expect(mem.read(`agencies/ag1/apiKeys/${key.id}`)?.revokedAt).toBeTruthy();
    expect((await callMcp(key.secret!)).status).toBe(401);
  });

  it("another agency's key id is 404 and stays unrevoked", async () => {
    const { key } = (await (await mint({ name: "k" })).json()) as MintBody;
    caller.value = { uid: "owner2", agencyId: "ag2" };
    expect((await revoke(key.id)).status).toBe(404);
    expect(mem.read(`agencies/ag1/apiKeys/${key.id}`)?.revokedAt).toBeNull();
  });
});

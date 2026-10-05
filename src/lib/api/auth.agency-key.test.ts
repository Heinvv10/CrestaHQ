import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Agency API keys (AGENCY_AGENT_API_PLAN.md A2, A3b) on the real auth path,
 * over an in-memory Firestore: an agency key authenticates (level from the
 * doc PATH, the agency's kill switch, the minter still an active owner). The
 * agent transports — /api/mcp and both tools routes — take it (A3b); a v1
 * resource route refuses it, logged under the agency, never a sub-account.
 * Every transport refuses it once the switch is off, the key is revoked or
 * the minter is no longer an active owner.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { GET: listContacts } = await import("@/app/api/v1/contacts/route");
const { POST: mcp } = await import("@/app/api/mcp/route");
const { GET: listTools } = await import("@/app/api/v1/tools/route");
const { POST: callTool } = await import("@/app/api/v1/tools/[name]/route");
const { mintApiKey } = await import("@/lib/api/keys");

const KEY_PATH = "agencies/ag1/apiKeys/ak1";
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

const headers = (key: string) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
});
const v1Contacts = (key: string) =>
  listContacts(new Request("http://localhost/api/v1/contacts", { headers: headers(key) }), {});
const mcpList = (key: string) =>
  mcp(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
const restTools = (key: string) =>
  listTools(new Request("http://localhost/api/v1/tools", { headers: headers(key) }), {});
const restCall = (key: string) =>
  callTool(
    new Request("http://localhost/api/v1/tools/find_contacts", {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ query: "ann", subAccountId: "sa1" }),
    }),
    { params: Promise.resolve({ name: "find_contacts" }) },
  );
const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
const settle = () => new Promise((r) => setTimeout(r, 10));
const pathsUnder = (prefix: string) => mem.all().map((d) => d.path).filter((p) => p.startsWith(prefix));

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { name: "Agency", agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { uid: "owner1", agencyId: "ag1", role: "owner", status: "active" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Private", email: "ann@private.io" });
  agencyKey = seedKey(KEY_PATH, { agencyId: "ag1", subAccountId: null, createdByUid: "owner1" });
  subKey = seedKey("subAccounts/sa1/apiKeys/k1", { agencyId: "ag1", subAccountId: "sa1", scopes: ["admin"], createdByUid: "u1" });
});

afterEach(async () => {
  await settle();
  // Nothing an agency key does may land under a sub-account named "null".
  expect(pathsUnder("subAccounts/null")).toEqual([]);
});

const TRANSPORTS: Array<[string, (key: string) => Promise<Response>]> = [
  ["POST /api/mcp", mcpList],
  ["GET /api/v1/tools", restTools],
  ["POST /api/v1/tools/find_contacts", restCall],
];

describe("an agency key on each transport", () => {
  it("GET /api/v1/contacts → 403 agency_key_not_allowed, logged under the agency only", async () => {
    const res = await v1Contacts(agencyKey);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("agency_key_not_allowed");
    await settle();
    const logs = mem.list("agencies/ag1/apiRequestLogs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ subAccountId: null, errorCode: "agency_key_not_allowed", requestBody: "" });
    expect(pathsUnder("subAccounts/").filter((p) => p.includes("/apiRequestLogs/"))).toEqual([]);
  });

  it.each(TRANSPORTS)("%s takes it → 200", async (_label, send) => {
    const res = await send(agencyKey);
    expect(res.status).toBe(200);
  });

  it("a targeted tools call logs under its target, the listing under the agency", async () => {
    expect((await restCall(agencyKey)).status).toBe(200);
    expect((await restTools(agencyKey)).status).toBe(200);
    await settle();
    expect(mem.list("subAccounts/sa1/apiRequestLogs")).toEqual([expect.objectContaining({ path: "/api/v1/tools/find_contacts" })]);
    expect(mem.list("agencies/ag1/apiRequestLogs")).toEqual([expect.objectContaining({ path: "/api/v1/tools" })]);
  });

  it("the agency key's lastUsedAt bump lands on its own doc", async () => {
    await mcpList(agencyKey);
    await settle();
    expect(mem.read(KEY_PATH)?.lastUsedAt).toBeDefined();
  });

  it("a sub-account key still works and logs under its sub-account", async () => {
    const res = await v1Contacts(subKey);
    expect(res.status).toBe(200);
    await settle();
    expect(mem.list("subAccounts/sa1/apiRequestLogs")).toHaveLength(1);
    expect(mem.list("agencies/ag1/apiRequestLogs")).toHaveLength(0);
  });
});

describe("the agency auth branch", () => {
  const ALL: Array<[string, (key: string) => Promise<Response>]> = [["GET /api/v1/contacts", v1Contacts], ...TRANSPORTS];

  it.each(ALL)("kill switch off → %s 403 agent_api_disabled", async (_label, send) => {
    mem.seed("agencies/ag1", { name: "Agency", agentApiEnabled: false });
    const res = await send(agencyKey);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("agent_api_disabled");
  });

  it.each(ALL)("revoked → %s 401 revoked_api_key", async (_label, send) => {
    mem.seed(KEY_PATH, { ...mem.read(KEY_PATH)!, revokedAt: new Date() });
    const res = await send(agencyKey);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("revoked_api_key");
  });

  it.each(ALL)("minter no longer an active owner → %s 401 minter_removed", async (_label, send) => {
    mem.seed("agencies/ag1/agencyMembers/owner1", { uid: "owner1", agencyId: "ag1", role: "staff", status: "active" });
    const res = await send(agencyKey);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("minter_removed");
  });

  it("kill switch unset (legacy agency doc) → 403 agent_api_disabled", async () => {
    mem.seed("agencies/ag1", { name: "Agency" });
    expect(await code(await mcpList(agencyKey))).toBe("agent_api_disabled");
  });

  it("revoked → 401 revoked_api_key", async () => {
    mem.seed(KEY_PATH, { ...mem.read(KEY_PATH)!, revokedAt: new Date() });
    const res = await mcpList(agencyKey);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("revoked_api_key");
  });

  it.each([
    ["demoted to staff", { role: "staff", status: "active" }],
    ["disabled", { role: "owner", status: "disabled" }],
  ])("minter %s → 401 minter_removed", async (_label, member) => {
    mem.seed("agencies/ag1/agencyMembers/owner1", { uid: "owner1", agencyId: "ag1", ...member });
    const res = await mcpList(agencyKey);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("minter_removed");
  });

  it("agency doc gone → 401 invalid_api_key, not a switch-off answer", async () => {
    await mem.db.doc("agencies/ag1").delete();
    const res = await mcpList(agencyKey);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("invalid_api_key");
  });

  it("minter's membership row gone → 401 minter_removed", async () => {
    mem.clear();
    mem.seed("agencies/ag1", { name: "Agency", agentApiEnabled: true });
    agencyKey = seedKey(KEY_PATH, { agencyId: "ag1", subAccountId: null, createdByUid: "owner1" });
    expect(await code(await mcpList(agencyKey))).toBe("minter_removed");
  });
});

describe("level and owner come from the doc path", () => {
  it("an agency key whose data claims a sub-account is still an agency key", async () => {
    agencyKey = seedKey(KEY_PATH, { agencyId: "ag2", subAccountId: "sa1", createdByUid: "owner1" });
    const res = await v1Contacts(agencyKey);
    expect(await code(res)).toBe("agency_key_not_allowed");
    await settle();
    expect(mem.list("subAccounts/sa1/apiRequestLogs")).toHaveLength(0);
    expect(mem.list("agencies/ag1/apiRequestLogs")).toHaveLength(1);
  });

  it("the switch and minter are read from the PATH's agency, not the data's", async () => {
    // Data names ag2, fully armed; the path's agency ag1 is switched off.
    mem.seed("agencies/ag2", { name: "Other", agentApiEnabled: true });
    mem.seed("agencies/ag2/agencyMembers/owner1", { uid: "owner1", agencyId: "ag2", role: "owner", status: "active" });
    mem.seed("agencies/ag1", { name: "Agency", agentApiEnabled: false });
    agencyKey = seedKey(KEY_PATH, { agencyId: "ag2", subAccountId: null, createdByUid: "owner1" });
    expect(await code(await mcpList(agencyKey))).toBe("agent_api_disabled");
  });

  it("an apiKeys doc under any other parent is no key, even one named like a live sub-account", async () => {
    const stray = seedKey("widgets/sa1/apiKeys/k9", { agencyId: "ag1", subAccountId: "sa1", scopes: ["admin"] });
    const res = await v1Contacts(stray);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("invalid_api_key");
  });
});

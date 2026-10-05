import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, inject, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * The `agent.call` audit (AGENCY_AGENT_API_PLAN.md D5, A3b): every call an
 * agency key makes in a sub-account it reached writes ONE row under
 * `agencies/{id}/agentCalls` — key, tool, target, read or write, never the
 * args — before the call runs. A refused call writes none anywhere. Real
 * dispatch and registry over an in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");
const { AGENT_CALL_TTL_MS } = await import("./agent-audit");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", timezone: "UTC", ...ON });
  mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", ...ON });
  mem.seed("subAccounts/sa3", { agencyId: "ag1", name: "Three", ...ON, agentApiEnabledByAgency: false });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Secret", createdAt: new Date() });
});

const callRows = () => mem.list("agencies/ag1/agentCalls");
const anyCallRows = () => mem.all().filter((d) => d.path.includes("/agentCalls/"));

describe("one agent.call row per targeted call", () => {
  it("a read: tool, target, access read, the key — and no args", async () => {
    expect(await dispatchAgentTool(agencyKey, "find_contacts", { subAccountId: "sa1", query: "ann secret" })).toMatchObject({ ok: true });
    expect(callRows()).toHaveLength(1);
    const { id: _id, ...row } = callRows()[0]!;
    expect(Object.keys(row).sort()).toEqual(["access", "action", "at", "expiresAt", "keyId", "keyPrefix", "subAccountId", "tool"]);
    expect(row).toMatchObject({ action: "agent.call", keyId: "ak1", tool: "find_contacts", subAccountId: "sa1", access: "read" });
    expect(JSON.stringify(row)).not.toContain("secret");
    expect((row.expiresAt as Date).getTime() - (row.at as Date).getTime()).toBe(AGENT_CALL_TTL_MS);
    expect(AGENT_CALL_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("a write is access write", async () => {
    expect(await dispatchAgentTool(agencyKey, "create_contact", { subAccountId: "sa1", name: "Ben" })).toMatchObject({ ok: true });
    expect(callRows()).toEqual([expect.objectContaining({ tool: "create_contact", subAccountId: "sa1", access: "write" })]);
  });

  it("past reach, a call that then fails (bad args) still has its row", async () => {
    expect(await dispatchAgentTool(agencyKey, "find_contacts", { subAccountId: "sa1" })).toMatchObject({ ok: false, scopedTo: "sa1" });
    expect(callRows()).toHaveLength(1);
  });

  it("an agency-level call naming a reached sub-account is recorded; one naming none is not", async () => {
    await dispatchAgentTool(agencyKey, "sub_account_stats", { subAccountId: "sa1", subAccountName: "One" });
    expect(callRows()).toEqual([expect.objectContaining({ tool: "sub_account_stats", subAccountId: "sa1", access: "read" })]);
    await dispatchAgentTool(agencyKey, "list_sub_accounts", {});
    expect(callRows()).toHaveLength(1);
  });

  it("each call of a sequence writes its own row", async () => {
    for (let i = 0; i < 3; i++) await dispatchAgentTool(agencyKey, "find_contacts", { subAccountId: "sa1", query: "ann" });
    expect(callRows()).toHaveLength(3);
  });
});

describe("refused calls write no agent.call row anywhere", () => {
  it.each([
    ["another agency's sub-account", "find_contacts", { subAccountId: "sa2", query: "ann" }],
    ["a gate-off sub-account", "find_contacts", { subAccountId: "sa3", query: "ann" }],
    ["no subAccountId", "find_contacts", { query: "ann" }],
    ["a chat-only name", "set_feature_gate", { subAccountId: "sa1" }],
    ["an unknown name", "__nope", { subAccountId: "sa1" }],
    ["an unreachable id on an agency-level call", "sub_account_stats", { subAccountId: "sa2", subAccountName: "x" }],
  ])("%s", async (_label, name, args) => {
    expect(await dispatchAgentTool(agencyKey, name, args)).toMatchObject({ ok: false });
    expect(anyCallRows()).toEqual([]);
  });

  it("the agency switch off", async () => {
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    expect(await dispatchAgentTool(agencyKey, "find_contacts", { subAccountId: "sa1", query: "ann" })).toMatchObject({ code: "agent_api_disabled" });
    expect(anyCallRows()).toEqual([]);
  });

  it("a sub-account key's calls are not agency calls", async () => {
    expect(await dispatchAgentTool(subKey, "find_contacts", { query: "ann" })).toMatchObject({ ok: true });
    expect(anyCallRows()).toEqual([]);
  });
});

describe("a call that cannot be recorded does not run", () => {
  it("the agent.call write throws → 500 under the target, the capability never executes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = await inject({ name: "__fixture_read", readonly: true });
    const collection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation((path: string) => {
      if (path.endsWith("/agentCalls")) throw new Error("firestore unavailable");
      return collection(path);
    });
    expect(await dispatchAgentTool(agencyKey, "__fixture_read", { subAccountId: "sa1" })).toEqual({
      ok: false, code: "internal_error", httpStatus: 500, message: "The tool failed to run.", scopedTo: "sa1",
    });
    expect(cap.execute).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

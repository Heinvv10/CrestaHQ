import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, inject, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";

/**
 * An agency key through dispatchAgentTool (AGENCY_AGENT_API_PLAN.md A3a):
 * `resolveReach` is the tenancy boundary — another agency's sub-account, a
 * gate off in either direction, and no such id all get ONE identical 404,
 * before any capability code — and a reached call runs the v1 pipeline
 * scoped to its target. The transports still refuse agency keys, so the
 * seams are called directly. Real registry over an in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool, agencyAgentCallable, agentCallable, AGENCY_AGENT_CALLABLE } = await import("./agent-dispatch");
const { agentPrecheck } = await import("./agent-precheck");
const { handleMcpRequest } = await import("./agent-mcp");
const { idempotencyOwner, reserveIdempotencyKey } = await import("./idempotency");
const { AI_SUITE_CAPABILITIES, CapabilityUserError, getCapability } = await import("@/lib/ai-suite/capabilities");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
const NOT_FOUND = { ok: false, code: "not_found", httpStatus: 404, message: "No such sub-account is available to this key." };
// sa2: another agency's · sa3: Agent API off · sa5: API access off · no doc ·
// a path to a doc that looks reachable · untrimmed ids, one of them a
// reachable doc whose trimmed id (sa3) is not.
const UNREACHABLE = ["sa2", "sa3", "sa5", "sa_missing", "sa1/contacts/c1", " sa1", "sa3 "];

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", timezone: "UTC", ...ON });
  mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", ...ON });
  mem.seed("subAccounts/sa3", { agencyId: "ag1", name: "Three", ...ON, agentApiEnabledByAgency: false });
  mem.seed("subAccounts/sa5", { agencyId: "ag1", name: "Five", ...ON, apiAccessEnabledByAgency: false });
  mem.seed("subAccounts/sa1/contacts/c1", { agencyId: "ag1", ...ON });
  mem.seed("subAccounts/sa3 ", { agencyId: "ag1", name: "Three, untrimmed", ...ON });
  for (const [id, sa] of [["c1", "sa1"], ["c2", "sa2"], ["c3", "sa3"]]) {
    mem.seed(`contacts/${id}`, { agencyId: sa === "sa2" ? "ag2" : "ag1", subAccountId: sa, name: `Ann ${sa}`, createdAt: new Date() });
  }
});

const subAccountPaths = () => mem.all().map((d) => d.path).filter((p) => p.startsWith("subAccounts/")).sort();

describe("resolveReach: one 404 for every sub-account the key may not act in", () => {
  it("every sub-account tool, for every unreachable target, before any capability code", async () => {
    const fixture = await inject({ name: "__fixture_read", readonly: true });
    const before = subAccountPaths();
    const tools = AI_SUITE_CAPABILITIES.filter(agentCallable);
    expect(tools.length).toBeGreaterThan(50);
    for (const cap of tools) {
      for (const target of UNREACHABLE) {
        expect(await dispatchAgentTool(agencyKey, cap.name, { subAccountId: target, query: "ann" })).toEqual(NOT_FOUND);
      }
    }
    expect(await dispatchAgentTool(agencyKey, "find_contacts", { query: "ann" })).toEqual(NOT_FOUND);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(subAccountPaths()).toEqual(before);
  });

  it("ANY subAccountId on an agency-level call is reach-checked (iterates the agency-callable set)", async () => {
    const agencyTools = AI_SUITE_CAPABILITIES.filter(agencyAgentCallable);
    expect(agencyTools.length).toBeGreaterThan(0);
    for (const cap of agencyTools) {
      const spy = vi.spyOn(cap, "execute");
      for (const target of UNREACHABLE) {
        expect(await dispatchAgentTool(agencyKey, cap.name, { subAccountId: target, subAccountName: "x" })).toEqual(NOT_FOUND);
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("precheck refuses the body's subAccountId with the same body, minus request_id", async () => {
    const bodies: unknown[] = [];
    for (const target of UNREACHABLE) {
      const res = await agentPrecheck(agencyKey, { subAccountId: target });
      expect(res?.status).toBe(404);
      const { error } = (await res!.json()) as { error: Record<string, unknown> };
      delete error.request_id;
      bodies.push(error);
    }
    expect(bodies[0]).toMatchObject({ code: "not_found", message: NOT_FOUND.message });
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(await agentPrecheck(agencyKey, { subAccountId: "sa1" })).toBeNull();
    expect(await agentPrecheck(agencyKey, {})).toBeNull();
  });
});

describe("the id reach checks is the id that runs", () => {
  it("sub_account_stats on a reachable 'sa3 ' decoy never counts the unreachable sa3", async () => {
    const r = await dispatchAgentTool(agencyKey, "sub_account_stats", { subAccountId: "sa3 ", subAccountName: "x" });
    expect(r).toEqual(NOT_FOUND);
    expect(JSON.stringify(r)).not.toContain("Three");
  });
});

describe("the agency kill switch", () => {
  it("is read fresh on every call: off → 403 agent_api_disabled, nothing runs", async () => {
    const cap = await inject({ name: "__fixture_read", readonly: true });
    expect(await dispatchAgentTool(agencyKey, "__fixture_read", { subAccountId: "sa1" })).toMatchObject({ ok: true });
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    expect(await dispatchAgentTool(agencyKey, "__fixture_read", { subAccountId: "sa1" })).toMatchObject({
      ok: false, code: "agent_api_disabled", httpStatus: 403,
    });
    expect(cap.execute).toHaveBeenCalledTimes(1);
  });
});

describe("a reached call runs scoped to its target", () => {
  it("sa1 → find_contacts returns sa1's rows only", async () => {
    const r = await dispatchAgentTool(agencyKey, "find_contacts", { subAccountId: "sa1", query: "ann" });
    expect(r).toMatchObject({ ok: true, scopedTo: "sa1" });
    const text = (r as { resultText: string }).resultText;
    expect(text).toContain("Ann sa1");
    expect(text).not.toContain("Ann sa2");
    expect(text).not.toContain("Ann sa3");
  });

  it("list_sub_accounts lists reachable sub-accounts only, filtered before the 50-row cap", async () => {
    // The untrimmed-id fixture is for reach only (auto-ids carry no whitespace).
    await mem.db.doc("subAccounts/sa3 ").delete();
    for (let i = 0; i < 50; i++) mem.seed(`subAccounts/a${String(i).padStart(2, "0")}`, { agencyId: "ag1", name: `Off ${i}` });
    mem.seed("subAccounts/zz_last", { agencyId: "ag1", name: "Last", ...ON });
    const r = (await dispatchAgentTool(agencyKey, "list_sub_accounts", {})) as { resultText: string };
    expect(r.resultText).toContain("(2):");
    expect(r.resultText).toContain("id: sa1");
    expect(r.resultText).toContain("id: zz_last");
    for (const hidden of ["sa2", "sa3", "sa5", "a00"]) expect(r.resultText).not.toContain(`id: ${hidden}.`);
    // Chat is unchanged: the first 50 of the agency, gates or not.
    const chat = await getCapability("list_sub_accounts")!.execute({ uid: "u", email: "", displayName: "", agencyId: "ag1" }, {});
    expect(chat.resultText).toContain("(50):");
    expect(chat.resultText).toContain("id: sa3.");
  });
});

describe("an agency-level member without a proposal path", () => {
  it.each([
    ["a write", { readonly: false }],
    ["a read with an approval class", { readonly: true, approval: "outbound" as const }],
    ["a read with approvalFor", { readonly: true, approvalFor: () => "outbound" as const }],
  ])("%s is not available, never executed", async (_label, shape) => {
    const cap = await inject({ name: "__fixture_agency", level: "agency", requiredRole: "agencyOwner", ...shape });
    const set = AGENCY_AGENT_CALLABLE as Set<string>;
    set.add(cap.name);
    try {
      expect(await dispatchAgentTool(agencyKey, cap.name, {})).toMatchObject({ ok: false, code: "not_available" });
    } finally {
      set.delete(cap.name);
    }
    expect(cap.execute).not.toHaveBeenCalled();
  });
});

describe("an agency-level member whose validate rewrites the id", () => {
  it.each([
    ["lowercases it", "SAX", (id: string) => id.toLowerCase()],
    ["resolves it to another sub-account", "sa1", () => "sa3"],
  ])("%s → the identical 404, never executed", async (_label, sent, rewrite) => {
    mem.seed("subAccounts/SAX", { agencyId: "ag1", name: "Upper", ...ON });
    const cap = await inject({
      name: "__fixture_agency_ids", level: "agency", requiredRole: "agencyOwner", readonly: true,
      validate: (raw) => ({ ok: true, args: { subAccountId: rewrite(String((raw as { subAccountId: unknown }).subAccountId)) } }),
    });
    const set = AGENCY_AGENT_CALLABLE as Set<string>;
    set.add(cap.name);
    try {
      expect(await dispatchAgentTool(agencyKey, cap.name, { subAccountId: sent })).toEqual(NOT_FOUND);
    } finally {
      set.delete(cap.name);
    }
    expect(cap.execute).not.toHaveBeenCalled();
  });
});

describe("past reach, every outcome keeps its target", () => {
  it("a thrown CapabilityUserError → 400 with scopedTo", async () => {
    await inject({ name: "__fixture_throw", execute: vi.fn(async () => { throw new CapabilityUserError("Not here."); }) });
    expect(await dispatchAgentTool(agencyKey, "__fixture_throw", { subAccountId: "sa1" })).toEqual({
      ok: false, code: "invalid_request", httpStatus: 400, message: "Not here.", scopedTo: "sa1",
    });
  });
});

describe("a sub-account key naming another sub-account", () => {
  it("→ 400 wrong_sub_account; its own id or none runs", async () => {
    const cap = await inject({ name: "__fixture_read", readonly: true });
    expect(await dispatchAgentTool(subKey, "__fixture_read", { subAccountId: "sa2" })).toMatchObject({
      ok: false, code: "wrong_sub_account", httpStatus: 400,
    });
    expect(cap.execute).not.toHaveBeenCalled();
    expect(await dispatchAgentTool(subKey, "__fixture_read", { subAccountId: "sa1" })).toMatchObject({ ok: true });
    expect(await dispatchAgentTool(subKey, "__fixture_read", {})).toMatchObject({ ok: true });
  });
});

describe("logs and idempotency by level", () => {
  const mcpCall = (subAccountId: string, name = "find_contacts") =>
    handleMcpRequest(
      agencyKey,
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      }),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { subAccountId, query: "ann" } } },
    );
  const logPaths = () => mem.all().map((d) => d.path).filter((p) => p.includes("/apiRequestLogs/"));
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("a refused call logs under the agency only; a reached one under its target", async () => {
    await mcpCall("sa2");
    await settle();
    expect(logPaths().filter((p) => p.startsWith("subAccounts/"))).toEqual([]);
    expect(logPaths().filter((p) => p.startsWith("agencies/ag1/apiRequestLogs/"))).toHaveLength(1);
    await mcpCall("sa1");
    await settle();
    expect(logPaths().filter((p) => p.startsWith("subAccounts/sa1/apiRequestLogs/"))).toHaveLength(1);
    expect(logPaths().filter((p) => p.startsWith("subAccounts/") && !p.startsWith("subAccounts/sa1/"))).toEqual([]);
  });

  it("a call that throws past reach logs under its target, as on REST", async () => {
    await inject({ name: "__fixture_throw", execute: vi.fn(async () => { throw new CapabilityUserError("Not here."); }) });
    await mcpCall("sa1", "__fixture_throw");
    await settle();
    expect(logPaths()).toHaveLength(1);
    expect(logPaths()[0]).toMatch(/^subAccounts\/sa1\/apiRequestLogs\//);
  });

  it("an agency key's Idempotency-Keys live under the agency, scoped or not", async () => {
    const scoped: ApiAuthContext = { ...agencyKey, level: "sub-account", subAccountId: "sa1", keyLevel: "agency" };
    expect(idempotencyOwner(scoped)).toEqual({ level: "agency", agencyId: "ag1" });
    expect(idempotencyOwner(subKey)).toEqual({ level: "sub-account", subAccountId: "sa1" });
    const r = await reserveIdempotencyKey(idempotencyOwner(agencyKey), "live", "ak1", "idem-1", "fp");
    expect(r.kind).toBe("reserved");
    const paths = mem.all().map((d) => d.path).filter((p) => p.includes("/apiIdempotency/"));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^agencies\/ag1\/apiIdempotency\//);
    if (r.kind === "reserved") await r.release();
  });
});

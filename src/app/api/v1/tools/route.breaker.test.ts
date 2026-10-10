import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The PR #262 breaker's repro cases (adversarial inputs against the REST
 * mirror), kept as regression tests. Same real withApiAuth + memory
 * Firestore harness as route.test.ts.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { GET } = await import("./route");
const { POST } = await import("./[name]/route");
const { mintApiKey } = await import("@/lib/api/keys");

let seq = 0;
function mintKey(scopes: string[], o: { mode?: "live" | "test"; revoked?: boolean; sa?: string } = {}) {
  const mode = o.mode ?? "live";
  const sa = o.sa ?? "sa1";
  const m = mintApiKey(mode);
  mem.seed(`subAccounts/${sa}/apiKeys/k${++seq}`, {
    subAccountId: sa, agencyId: "ag1", name: "Agent key", mode,
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes, revokedAt: o.revoked ? new Date() : null, createdAt: new Date(),
  });
  return m.rawKey;
}
let key = "";
const call = (name: string, body: unknown, extra: Record<string, string> = {}, raw?: string) =>
  POST(
    new Request(`http://localhost/api/v1/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extra },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );
const list = (auth = `Bearer ${key}`) =>
  GET(new Request("http://localhost/api/v1/tools", { headers: { authorization: auth } }), { params: undefined });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Private", email: "ann@private.io" });
  mem.seed("contacts/c2", { agencyId: "ag1", subAccountId: "sa2", name: "Bob Other", email: "bob@other.io" });
  mem.seed("deals/d2", { agencyId: "ag1", subAccountId: "sa2", title: "Bob Deal", stageId: "new", pipelineId: "default" });
  mem.seed("tasks/t2", { agencyId: "ag1", subAccountId: "sa2", title: "Bob Task", completed: false });
  key = mintKey(["agent"]);
});

describe("cross-tenant", () => {
  it("model-supplied B ids never touch or reveal B", async () => {
    const before = JSON.stringify([mem.read("contacts/c2"), mem.read("deals/d2"), mem.read("tasks/t2")]);
    const out: string[] = [];
    for (const [n, a] of [
      ["move_deal_stage", { dealId: "d2", dealTitle: "x", stage: "won" }],
      ["complete_task", { taskId: "t2", taskTitle: "x" }],
      ["create_deal", { title: "t", value: 0, contactId: "c2" }], ["create_deal", { title: "t2", value: 0, contactName: "Bob Other" }],
      ["create_task", { title: "t", contactId: "c2" }],
      ["create_event", { title: "t", date: "2026-10-01", time: "10:00", contactId: "c2" }],
      ["find_contacts", { query: "bob", subAccountId: "sa2" }],
      ["find_contacts", { query: "bob", agencyId: "ag1", subAccountId: "sa2" }],
      ["find_deals", { query: "Bob", subAccountId: "sa2" }],
      ["find_tasks", { subAccountId: "sa2" }],
    ] as const) {
      const r = await call(n, a);
      out.push(`${n} ${r.status} ${await r.text()}`);
    }
    const joined = out.join("\n");
    expect(joined).not.toMatch(/Bob Other|bob@other\.io|Bob Deal|Bob Task/);
    expect(JSON.stringify([mem.read("contacts/c2"), mem.read("deals/d2"), mem.read("tasks/t2")])).toBe(before);
    // no created doc in sa2 pointing at c2
    const leaked = mem.all().filter((d) => (d.data as { subAccountId?: string }).subAccountId === "sa2" && !["contacts/c2", "deals/d2", "tasks/t2", "subAccounts/sa2"].includes(d.path));
    expect(leaked).toEqual([]);
    // any sa1 doc linked to B's contact?
    const linked = mem.all().filter((d) => JSON.stringify(d.data).includes('"c2"') && d.path.startsWith("") && (d.data as { subAccountId?: string }).subAccountId === "sa1");
    expect(linked.map((l) => l.path)).toEqual([]);
  });
});

describe("keys and scope", () => {
  it.each([
    ["revoked", () => mintKey(["agent"], { revoked: true }), 401],
    ["test mode", () => mintKey(["agent"], { mode: "test" }), 400],
    ["admin", () => mintKey(["admin"]), 403],
    ["forms-ingest", () => mintKey(["forms-ingest"]), 403],
  ])("%s key never reaches dispatch", async (_l, mk, status) => {
    key = mk();
    const r = await call("create_contact", { name: "Evil" });
    expect(r.status).toBe(status);
    expect(mem.all().filter((d) => d.path.startsWith("contacts/") && JSON.stringify(d.data).includes("Evil"))).toEqual([]);
  });
  it("test-mode key: GET /tools also refused", async () => {
    key = mintKey(["agent"], { mode: "test" });
    const r = await list();
    expect(r.status).not.toBe(200);
  });
  it("gates flipped off after mint", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), apiAccessEnabledByAgency: false });
    expect((await call("create_contact", { name: "Evil" })).status).toBe(403);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), apiAccessEnabledByAgency: true, agentApiEnabledByAgency: false });
    expect((await call("create_contact", { name: "Evil" })).status).toBe(403);
  });
  it("malformed bearers", async () => {
    for (const a of ["", "Bearer", "Bearer lsk_live_x", `Basic ${key}`, `Bearer ${key}x`, `Bearer ${key.replace("live", "test")}`]) {
      expect([401]).toContain((await list(a)).status);
    }
  });
});

describe("name tricks", () => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "FIND_CONTACTS", "find_contacts ", "find_contacts/", "../contacts", "create_webhook", "list_sub_accounts", "create_webhook\u0000", "find_contacts%00"])(
    "%j → 404 not_available, never 500",
    async (n) => {
      const r = await call(n, {});
      expect(r.status).toBe(404);
    },
  );
});

describe("body tricks", () => {
  it.each([["array", "[1,2]"], ["string", '"x"'], ["number", "5"], ["null", "null"], ["bad json", "{"], ["true", "true"]])("%s body → 4xx, never 500", async (_l, raw) => {
    const r = await call("create_contact", null, {}, raw);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
  it("prototype pollution in args", async () => {
    await call("create_contact", null, {}, '{"name":"P","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    const c = mem.all().find((d) => d.path.startsWith("contacts/") && (d.data as { name?: string }).name === "P");
    expect(Object.keys(c?.data ?? {})).not.toContain("__proto__");
  });
  it("a smuggled subAccountId is refused, never silently dropped", async () => {
    const r = await call("create_contact", { name: "Smug2", subAccountId: "sa2" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("wrong_sub_account");
    expect(mem.all().some((d) => d.path.startsWith("contacts/") && (d.data as { name?: string }).name === "Smug2")).toBe(false);
  });
  it("smuggled tenancy/approval fields not persisted", async () => {
    const r = await call("create_contact", { name: "Smug", agencyId: "agX", approval: "outbound", surfaces: ["chat"], createdByUid: "victim" });
    expect(r.status).toBe(200);
    const c = mem.all().find((d) => d.path.startsWith("contacts/") && (d.data as { name?: string }).name === "Smug")!;
    expect(c.data).toMatchObject({ subAccountId: "sa1", agencyId: "ag1" });
    expect(c.data.createdByUid).not.toBe("victim");
  });
  // REPRO 5 (no body size limit) predates PR4 and affects every v1 route:
  // tracked separately, deliberately not asserted here.
});

describe("idempotency", () => {
  it("same Idempotency-Key on a different tool never replays the other action", async () => {
    const a = await call("create_contact", { name: "Idem1" }, { "idempotency-key": "k1" });
    expect(a.status).toBe(200);
    const b = await call("create_task", { title: "Idem task" }, { "idempotency-key": "k1" });
    expect(b.status).not.toBe(200);
    const c = await call("create_contact", { name: "Idem2" }, { "idempotency-key": "k1" });
    expect(c.status).not.toBe(200);
    expect(mem.all().filter((d) => d.path.startsWith("contacts/") && /Idem/.test(JSON.stringify(d.data)))).toHaveLength(1);
  });
  it("read with same key does not bypass/erase a write cache", async () => {
    await call("create_contact", { name: "IdemR" }, { "idempotency-key": "k2" });
    await call("find_contacts", { query: "x" }, { "idempotency-key": "k2" });
    await call("create_contact", { name: "IdemR" }, { "idempotency-key": "k2" });
    expect(mem.all().filter((d) => d.path.startsWith("contacts/") && /IdemR/.test(JSON.stringify(d.data)))).toHaveLength(1);
  });
  it("encoded name path vs plain path with same key: no double execute", async () => {
    await POST(new Request("http://localhost/api/v1/tools/create%5Fcontact", { method: "POST", headers: { authorization: `Bearer ${key}`, "idempotency-key": "k3" }, body: '{"name":"Enc"}' }), { params: Promise.resolve({ name: "create_contact" }) });
    await call("create_contact", { name: "Enc" }, { "idempotency-key": "k3" });
    expect(mem.all().filter((d) => d.path.startsWith("contacts/") && /"Enc"/.test(JSON.stringify(d.data)))).toHaveLength(1);
  });
  it("agent gate off: an Idempotency-Key replay of a cached write is 403 (REPRO 3)", async () => {
    expect((await call("create_contact", { name: "Gated" }, { "idempotency-key": "k4" })).status).toBe(200);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    const r = await call("create_contact", { name: "Gated" }, { "idempotency-key": "k4" });
    expect(r.status).toBe(403);
  });
  it("a transient 403 agent_api_disabled is NOT cached: re-enabled, the same key → 200 (REPRO 2)", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: false });
    expect((await call("create_contact", { name: "Sticky" }, { "idempotency-key": "k5" })).status).toBe(403);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), agentApiEnabledByAgency: true });
    const r = await call("create_contact", { name: "Sticky" }, { "idempotency-key": "k5" });
    expect(r.status).toBe(200);
  });
});

describe("PII persistence", () => {
  const logFor = (res: Response) =>
    mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.requestId === res.headers.get("x-request-id"));
  it("after a read by email, no collection holds the contact's name or email", async () => {
    const r = await call("find_contacts", { query: "ann@private.io" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Ann Private");
    // The request log is the row that could hold PII: wait for it, or this checks nothing.
    await flushAfterResponse();
    expect(logFor(r)).toHaveLength(1);
    const hits = mem.all().filter((d) => d.path !== "contacts/c1" && /Ann Private|ann@private\.io/.test(JSON.stringify(d.data)));
    expect(hits.map((h) => `${h.path}: ${JSON.stringify(h.data).slice(0, 300)}`)).toEqual([]);
  });
  it("after a read by name, no collection holds the contact's name", async () => {
    const r = await call("find_contacts", { query: "Ann Private" });
    // The request log is the row that could hold PII: wait for it, or this checks nothing.
    await flushAfterResponse();
    expect(logFor(r)).toHaveLength(1);
    const hits = mem.all().filter((d) => d.path !== "contacts/c1" && /Ann Private/.test(JSON.stringify(d.data)));
    expect(hits.map((h) => h.path)).toEqual([]);
  });
});

const contacts = (re: RegExp) => mem.all().filter((d) => d.path.startsWith("contacts/") && re.test(JSON.stringify(d.data)));

describe("rate limit", () => {
  it("one request = one token and one tool", async () => {
    const r = await call("find_contacts", [{ query: "a" }, { query: "b" }]);
    const r2 = await call("find_contacts", { query: "a" });
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("58");
    void r;
  });
});

describe("round 2", () => {
  it("A2 a Firestore failure inside precheck is a logged, generic 500 — not an unhandled throw, never cached", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const orig = mem.db.doc.bind(mem.db);
    let n = 0;
    // The 1st subAccounts/sa1 read is auth's; the 2nd is the precheck's gate read.
    const spy = vi.spyOn(mem.db, "doc").mockImplementation(((p: string) => {
      if (p === "subAccounts/sa1" && ++n === 2) throw new Error("UNAVAILABLE internal-host-10.0.0.5");
      return orig(p);
    }) as never);
    let res: Response | string;
    try {
      res = await call("create_contact", { name: "X" }, { "idempotency-key": "a2" });
    } catch (e) {
      res = `threw: ${(e as Error).message}`;
    }
    spy.mockRestore();
    expect(typeof res).not.toBe("string");
    const r = res as Response;
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
    expect(text).not.toContain("internal-host");
    expect(logged).toHaveBeenCalledWith("[api/v1] precheck threw", expect.any(Error));
    await flushAfterResponse();
    expect(mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.path === "/api/v1/tools/create_contact")).toHaveLength(1);
    const rows = mem.list("subAccounts/sa1/apiRequestLogs").filter((l) => l.path === "/api/v1/tools/create_contact");
    expect(rows[0]).toMatchObject({ responseStatus: 500, errorCode: "internal_error" });
    expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
    expect(contacts(/"X"/)).toEqual([]);
    logged.mockRestore();
  });

  it("A1 three parallel create_contact under one Idempotency-Key create exactly one contact", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => call("create_contact", { name: "Race One" }, { "idempotency-key": "race-1" }))
    );
    expect(contacts(/"Race One"/)).toHaveLength(1);
    for (const r of results) {
      if (r.status === 409) expect(await r.json()).toMatchObject({ error: { code: "idempotency_in_progress" } });
      else expect(r.status).toBe(200);
    }
  });
});

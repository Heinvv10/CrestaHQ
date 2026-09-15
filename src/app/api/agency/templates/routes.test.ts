import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Seam tests for the template-library routes: real handlers, real
 * captureEntity / pushTemplate / applySnapshot, in-memory Firestore. Only the
 * auth gate is faked, and it is faked per-test so the 403 is the route's own.
 */
const mem = createMemoryFirestore();
const db = Object.assign(mem.db, {
  batch: () => {
    const pending: Array<[{ set: (d: Record<string, unknown>) => Promise<void> }, Record<string, unknown>]> = [];
    return {
      set: (ref: { set: (d: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
        void pending.push([ref, data]),
      commit: async () => {
        for (const [ref, data] of pending) await ref.set(data);
      },
    };
  },
});
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));

const auth = vi.hoisted(() => ({
  caller: null as null | { uid: string; agencyId: string | null; agencyRole: string | null },
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireAgencyOwnerAny: async () => {
    const c = auth.caller;
    if (!c) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    if (c.agencyRole !== "owner" || !c.agencyId) {
      return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
    }
    return { ...c, email: "", status: "active" };
  },
}));

const list = await import("./route");
const item = await import("./[id]/route");
const push = await import("./[id]/push/route");

const OWNER = { uid: "owner1", agencyId: "ag1", agencyRole: "owner" };
const json = (body: unknown, method = "POST") =>
  new Request("http://x/api/agency/templates", {
    method,
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mem.clear();
  auth.caller = OWNER;
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1" });
  mem.seed("subAccounts/foreign", { agencyId: "ag2" });
  mem.seed("workflows/w1", {
    id: "w1",
    name: "Follow up",
    status: "active",
    trigger: { type: "contact.created", filters: { all: [], match: "all" } },
    startNodeId: null,
    nodes: {},
    stats: { enrolled: 3, completed: 1 },
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mem.seed("agencies/ag1/templates/tpl1", {
    id: "tpl1",
    agencyId: "ag1",
    kind: "workflow",
    name: "Lib wf",
    description: "",
    tags: ["a"],
    sourceSubAccountId: "sa1",
    payload: {
      forms: [],
      messageTemplates: [],
      products: [],
      workflows: [
        {
          sourceId: "w9",
          name: "Lib wf",
          status: "active",
          trigger: { type: "contact.created" },
          startNodeId: null,
          nodes: {},
        },
      ],
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mem.seed("agencies/ag2/templates/tpl_foreign", {
    id: "tpl_foreign",
    agencyId: "ag2",
    kind: "form",
    name: "Foreign",
    tags: [],
    payload: { forms: [], messageTemplates: [], products: [], workflows: [] },
    createdAt: new Date(),
  });
});

describe("auth gate", () => {
  it.each([
    ["GET list", () => list.GET(json({}, "GET"))],
    ["POST capture", () => list.POST(json({ subAccountId: "sa1", kind: "workflow", entityId: "w1" }))],
    ["PATCH", () => item.PATCH(json({ name: "x" }, "PATCH"), params("tpl1"))],
    ["DELETE", () => item.DELETE(json({}, "DELETE"), params("tpl1"))],
    ["POST push", () => push.POST(json({ subAccountIds: ["sa1"] }), params("tpl1"))],
  ])("%s → 403 for a non-owner and nothing is written", async (_l, call) => {
    auth.caller = { uid: "m", agencyId: "ag1", agencyRole: null };
    const res = await call();
    expect(res.status).toBe(403);
    expect(mem.read("agencies/ag1/templates/tpl1")?.name).toBe("Lib wf");
    expect(mem.list("agencies/ag1/templates")).toHaveLength(1);
    expect(mem.list("workflows")).toHaveLength(1);
  });
});

describe("GET /api/agency/templates", () => {
  it("lists only the caller agency's templates, without payload", async () => {
    const res = await list.GET(json({}, "GET"));
    const body = await res.json();
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]).toMatchObject({ id: "tpl1", kind: "workflow", tags: ["a"], includesTriggerForm: false });
    expect(body.templates[0]).not.toHaveProperty("payload");
  });
});

describe("POST /api/agency/templates", () => {
  it("captures the entity into the caller's agency with the entity name as default", async () => {
    const res = await list.POST(json({ subAccountId: "sa1", kind: "workflow", entityId: "w1", tags: ["Sales", "sales ", ""] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const doc = mem.read(`agencies/ag1/templates/${body.templateId}`)!;
    expect(doc).toMatchObject({ agencyId: "ag1", createdByUid: "owner1", kind: "workflow", name: "Follow up", sourceSubAccountId: "sa1", tags: ["Sales", "sales"], version: 1 });
    const wf = (doc.payload as { workflows: Record<string, unknown>[] }).workflows[0];
    expect(wf).not.toHaveProperty("stats");
    expect(wf).not.toHaveProperty("subAccountId");
  });

  it.each([
    [{ kind: "workflow", entityId: "w1" }, "subAccountId"],
    [{ subAccountId: "sa1", kind: "sms", entityId: "w1" }, "kind"],
    [{ subAccountId: "sa1", kind: "workflow", entityId: "w1", name: "x".repeat(81) }, "Name"],
    [{ subAccountId: "sa1", kind: "workflow", entityId: "w1", description: "x".repeat(301) }, "Description"],
    [{ subAccountId: "sa1", kind: "workflow", entityId: "w1", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "tags"],
    [{ subAccountId: "sa1", kind: "workflow", entityId: "w1", tags: "a" }, "Tags"],
  ])("rejects %j with 400", async (body, word) => {
    const res = await list.POST(json(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(word);
    expect(mem.list("agencies/ag1/templates")).toHaveLength(1);
  });

  it("404s a sub-account outside the agency and an entity outside the sub-account", async () => {
    expect((await list.POST(json({ subAccountId: "foreign", kind: "workflow", entityId: "w1" }))).status).toBe(404);
    expect((await list.POST(json({ subAccountId: "sa2", kind: "workflow", entityId: "w1" }))).status).toBe(404);
    expect(mem.list("agencies/ag1/templates")).toHaveLength(1);
  });
});

describe("PATCH + DELETE /api/agency/templates/[id]", () => {
  it("updates metadata in place and leaves the payload alone", async () => {
    const res = await item.PATCH(json({ name: "Renamed", tags: ["b"] }, "PATCH"), params("tpl1"));
    expect(res.status).toBe(200);
    const doc = mem.read("agencies/ag1/templates/tpl1")!;
    expect(doc.name).toBe("Renamed");
    expect(doc.tags).toEqual(["b"]);
    expect((doc.payload as { workflows: unknown[] }).workflows).toHaveLength(1);
  });

  it("rejects an empty patch and an over-long name", async () => {
    expect((await item.PATCH(json({}, "PATCH"), params("tpl1"))).status).toBe(400);
    expect((await item.PATCH(json({ name: "" }, "PATCH"), params("tpl1"))).status).toBe(400);
    expect(mem.read("agencies/ag1/templates/tpl1")?.name).toBe("Lib wf");
  });

  it("cannot reach another agency's template by id", async () => {
    expect((await item.PATCH(json({ name: "x" }, "PATCH"), params("tpl_foreign"))).status).toBe(404);
    expect((await item.DELETE(json({}, "DELETE"), params("tpl_foreign"))).status).toBe(404);
    expect(mem.read("agencies/ag2/templates/tpl_foreign")?.name).toBe("Foreign");
  });

  it("deletes the caller's own template", async () => {
    expect((await item.DELETE(json({}, "DELETE"), params("tpl1"))).status).toBe(200);
    expect(mem.read("agencies/ag1/templates/tpl1")).toBeUndefined();
  });
});

describe("POST /api/agency/templates/[id]/push", () => {
  it("applies to each target as a draft and reports per-target, refusing the foreign one", async () => {
    const res = await push.POST(json({ subAccountIds: ["sa1", "foreign", "sa2", "sa2"] }), params("tpl1"));
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results).toEqual([
      { subAccountId: "sa1", ok: true, created: { forms: 0, messageTemplates: 0, workflows: 1 } },
      { subAccountId: "foreign", ok: false, error: "Sub-account not found in this agency.", created: { forms: 0, messageTemplates: 0, workflows: 0 } },
      { subAccountId: "sa2", ok: true, created: { forms: 0, messageTemplates: 0, workflows: 1 } },
    ]);
    const pushed = mem.list("workflows").filter((w) => w.name === "Lib wf");
    expect(pushed.map((w) => w.subAccountId).sort()).toEqual(["sa1", "sa2"]);
    for (const w of pushed) {
      expect(w.status).toBe("draft");
      expect(w.agencyId).toBe("ag1");
      expect(w.createdByUid).toBe("owner1");
    }
  });

  it.each([[{}], [{ subAccountIds: [] }], [{ subAccountIds: "sa1" }], [{ subAccountIds: [""] }], [{ subAccountIds: Array.from({ length: 51 }, (_, i) => `s${i}`) }]])(
    "rejects %j with 400 and writes nothing",
    async (body) => {
      expect((await push.POST(json(body), params("tpl1"))).status).toBe(400);
      expect(mem.list("workflows")).toHaveLength(1);
    },
  );

  it("404s a template from another agency", async () => {
    expect((await push.POST(json({ subAccountIds: ["sa1"] }), params("tpl_foreign"))).status).toBe(404);
    expect((await push.POST(json({ subAccountIds: ["sa1"] }), params("nope"))).status).toBe(404);
  });
});

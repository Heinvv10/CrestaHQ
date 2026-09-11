import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH / DELETE one pipeline, through the real handler, real pipelines lib
 * and an in-memory Firestore. Only the auth guard is stubbed.
 *
 * The point of these: a stage that still holds deals must be refused, or a
 * save strands those deals on a column that no longer renders.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1", agencyId: "ag1" }),
}));

const { DELETE, PATCH } = await import("./route");

const ctx = (pipelineId: string) => ({
  params: Promise.resolve({ id: "sa1", pipelineId }),
});
const req = (method: string, body?: unknown) =>
  new Request("http://x/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const stage = (id: string, terminal?: "won" | "lost") => ({
  id,
  label: id,
  tone: "",
  ...(terminal ? { terminal } : {}),
});

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ownerUid: "u1" });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals",
    stages: [stage("open"), stage("closed", "won")],
    isDefault: false,
    agencyId: "ag1",
    subAccountId: "sa1",
  });
});

describe("PATCH stages", () => {
  it("refuses to drop a stage that still has deals — 409 with the count", async () => {
    mem.seed("deals/d1", { subAccountId: "sa1", pipelineId: "p2", stageId: "open" });
    mem.seed("deals/d2", { subAccountId: "sa1", pipelineId: "p2", stageId: "open" });

    const res = await PATCH(
      req("PATCH", { stages: [{ id: "closed", label: "Closed", terminal: "won" }] }),
      ctx("p2"),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stageId: "open", count: 2 });
    // Nothing written.
    expect(mem.read("subAccounts/sa1/pipelines/p2")?.stages).toHaveLength(2);
  });

  it("drops an empty stage, renames and reorders, keeping ids", async () => {
    mem.seed("deals/d1", { subAccountId: "sa1", pipelineId: "p2", stageId: "closed" });
    const res = await PATCH(
      req("PATCH", {
        name: "Renewals 2",
        stages: [
          { id: "closed", label: "Won!", terminal: "won" },
          { label: "Needs review" },
        ],
      }),
      ctx("p2"),
    );
    expect(res.status).toBe(200);
    const stored = mem.read("subAccounts/sa1/pipelines/p2")!;
    expect(stored.name).toBe("Renewals 2");
    expect((stored.stages as { id: string; label: string }[]).map((s) => [s.id, s.label])).toEqual([
      ["closed", "Won!"],
      ["needs_review", "Needs review"],
    ]);
  });

  it("refuses two won stages", async () => {
    const res = await PATCH(
      req("PATCH", {
        stages: [
          { label: "A", terminal: "won" },
          { label: "B", terminal: "won" },
        ],
      }),
      ctx("p2"),
    );
    expect(res.status).toBe(400);
  });

  it("seeds and edits the default pipeline in place", async () => {
    const res = await PATCH(req("PATCH", { name: "Sales" }), ctx("default"));
    expect(res.status).toBe(200);
    const stored = mem.read("subAccounts/sa1/pipelines/default")!;
    expect(stored.name).toBe("Sales");
    expect(stored.isDefault).toBe(true);
  });
});

describe("DELETE", () => {
  it("refuses the default pipeline", async () => {
    const res = await DELETE(req("DELETE"), ctx("default"));
    expect(res.status).toBe(409);
    expect(mem.read("subAccounts/sa1/pipelines/default")).toBeDefined();
  });

  it("refuses a pipeline with deals, deletes an empty one", async () => {
    mem.seed("deals/d1", { subAccountId: "sa1", pipelineId: "p2", stageId: "open" });
    expect((await DELETE(req("DELETE"), ctx("p2"))).status).toBe(409);
    expect(mem.read("subAccounts/sa1/pipelines/p2")).toBeDefined();

    await mem.db.doc("deals/d1").delete();
    expect((await DELETE(req("DELETE"), ctx("p2"))).status).toBe(200);
    expect(mem.read("subAccounts/sa1/pipelines/p2")).toBeUndefined();
  });
});

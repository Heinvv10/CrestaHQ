import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The stale deals config route: the agency gate refuses both reads and
 * writes, a path id is checked before any read, and pipeline / stage
 * filters are checked against the sub-account's real pipelines.
 */

const mem = createMemoryFirestore();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1", subAccountRole: "admin" }),
}));

const { GET, PATCH } = await import("./route");

const ctx = (id = "sa1") => ({ params: Promise.resolve({ id }) });
const get = (id?: string) => GET(new Request("https://app.test/x"), ctx(id));
const patch = (body: unknown, id?: string) =>
  PATCH(new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify(body) }), ctx(id));

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", agentsEnabledByAgency: true });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals",
    isDefault: false,
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "renewed", label: "Renewed", tone: "", terminal: "won" },
    ],
  });
});

it("gate on: enables the monitor and reads it back", async () => {
  const res = await patch({ enabled: true, thresholdDays: 5, pipelineIds: ["p2"], excludeStageKeys: ["default:qualified"] });
  expect(res.status).toBe(200);
  expect(mem.read("customAgents/sa1_stale-deals")).toMatchObject({
    subAccountId: "sa1",
    agencyId: "ag1",
    type: "stale-deals",
    enabled: true,
    thresholdDays: 5,
    pipelineIds: ["p2"],
    excludeStageKeys: ["default:qualified"],
  });
  const read = await get();
  expect(read.status).toBe(200);
  expect(((await read.json()) as { config: { enabled: boolean } }).config.enabled).toBe(true);
});

it("gate off: GET and PATCH are 403 and nothing is written", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", agentsEnabledByAgency: false });
  expect((await get()).status).toBe(403);
  expect((await patch({ enabled: true })).status).toBe(403);
  expect((await patch({ thresholdDays: 10 })).status).toBe(403);
  expect(mem.read("customAgents/sa1_stale-deals")).toBeUndefined();
});

it("a path id that isn't a doc id is 404 before any read", async () => {
  // A doc a traversal id would land on, carrying a gate that reads as on.
  mem.seed("subAccounts/sa1/x/y", { agencyId: "ag1", agentsEnabledByAgency: true });
  expect((await get("sa1/x/y")).status).toBe(404);
  expect((await patch({ enabled: true }, "sa1/x/y")).status).toBe(404);
});

it("refuses unknown pipelines, stage keys and out-of-range thresholds", async () => {
  expect((await patch({ pipelineIds: ["nope"] })).status).toBe(400);
  expect((await patch({ excludeStageKeys: ["p2:missing"] })).status).toBe(400);
  expect((await patch({ excludeStageKeys: ["p2"] })).status).toBe(400);
  expect((await patch({ thresholdDays: 2 })).status).toBe(400);
  expect((await patch({ thresholdDays: 61 })).status).toBe(400);
  expect(mem.read("customAgents/sa1_stale-deals")).toBeUndefined();
});

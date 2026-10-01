import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * Public API v1 deal writes append stage-history rows, through the REAL
 * withApiAuth and routes over an in-memory Firestore. This is the path the
 * QContact stage sync uses. Stubbed: webhooks and the workflow engine.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const webhooks: string[] = [];
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: async (e: { type: string }) => void webhooks.push(e.type),
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

let key = "";
let prefix = "";
const rows = () => mem.list("dealStageHistory");
const req = (method: string, path: string, body: unknown) =>
  new Request(`https://app.test${path}`, {
    method, headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });

beforeEach(() => {
  mem.clear();
  webhooks.length = 0;
  mem.seed("subAccounts/sa1", { name: "SA", agencyId: "ag1", apiAccessEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann" });
  const k = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/key1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live", prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  key = k.rawKey;
  prefix = k.prefix;
});

it("POST writes the entry row and PATCH stage appends a move row; a same-stage PATCH does not", async () => {
  const created = await POST(
    req("POST", "/api/v1/deals", { title: "D", value: 1, currency: "USD", contact_id: "c1", stage: "new" }),
    { params: undefined },
  );
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { deal: { id: string } }).deal.id;
  expect(rows()).toEqual([
    expect.objectContaining({
      dealId: id, stageId: "new", fromStageId: null, source: "api",
      createdByUid: `apikey:${prefix}`, subAccountId: "sa1", agencyId: "ag1", mode: "live",
    }),
  ]);

  const patch = (body: unknown) =>
    PATCH(req("PATCH", `/api/v1/deals/${id}`, body), { params: Promise.resolve({ id }) });
  expect((await patch({ stage: "qualified" })).status).toBe(200);
  expect((await patch({ stage: "qualified", title: "Renamed" })).status).toBe(200);
  expect(rows().filter((r) => r.fromStageId !== null)).toEqual([
    expect.objectContaining({ dealId: id, fromStageId: "new", stageId: "qualified", source: "api" }),
  ]);
  expect(mem.read(`deals/${id}`)?.stageId).toBe("qualified");
});

/** Change the stored deal after the route's first read, before its transaction. */
async function raceBeforeTx(id: string, change: Record<string, unknown>, body: unknown) {
  const realTx = mem.db.runTransaction;
  mem.db.runTransaction = ((fn: never) => {
    mem.seed(`deals/${id}`, { ...mem.read(`deals/${id}`), ...change });
    return realTx(fn);
  }) as typeof realTx;
  try {
    return await PATCH(req("PATCH", `/api/v1/deals/${id}`, body), { params: Promise.resolve({ id }) });
  } finally {
    mem.db.runTransaction = realTx;
  }
}

function seedDeal(id: string, data: Record<string, unknown> = {}) {
  mem.seed(`deals/${id}`, {
    title: "D", value: 1, currency: "USD", contactId: "c1", stageId: "new",
    subAccountId: "sa1", agencyId: "ag1", mode: "live", ...data,
  });
}

it("a deal re-homed to another sub-account before the commit is 404 — nothing written", async () => {
  seedDeal("d1");
  const res = await raceBeforeTx("d1", { subAccountId: "sa2" }, { stage: "qualified" });
  expect(res.status).toBe(404);
  expect(mem.read("deals/d1")?.stageId).toBe("new");
  expect(rows()).toEqual([]);
});

it("the stage is validated against the pipeline the deal is on AT commit", async () => {
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "won", label: "Renewed", tone: "" },
    ],
  });
  seedDeal("d1");
  // "qualified" is a default-pipeline stage; the deal moved to p2 meanwhile.
  const bad = await raceBeforeTx("d1", { pipelineId: "p2", stageId: "open" }, { stage: "qualified" });
  expect(bad.status).toBe(400);
  expect(mem.read("deals/d1")?.stageId).toBe("open");
  expect(rows()).toEqual([]);

  // On p2 "won" is NOT terminal, so no deal.won — the default pipeline's
  // terminal flag must not leak in from the stale read.
  seedDeal("d2");
  const ok = await raceBeforeTx("d2", { pipelineId: "p2", stageId: "open" }, { stage: "won" });
  expect(ok.status).toBe(200);
  await new Promise((r) => setTimeout(r, 5));
  expect(webhooks).not.toContain("deal.won");
  expect(rows()).toEqual([expect.objectContaining({ dealId: "d2", fromStageId: "open", pipelineId: "p2", stageId: "won" })]);
});

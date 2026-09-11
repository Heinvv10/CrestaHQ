import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * Public API v1 deals with pipelines, through the REAL withApiAuth and the
 * real pipelines lib over an in-memory Firestore. Stubbed: outbound
 * webhooks (captured) and the workflow engine.
 *
 *   POST /api/v1/deals            — pipeline_id accepted; stage must be on it
 *   PATCH /api/v1/deals/:id       — stage validated against the deal's OWN
 *                                   pipeline; won/lost by its terminal flags
 */

const mem = createMemoryFirestore();
const webhooks: string[] = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: async (e: { type: string }) => {
    webhooks.push(e.type);
  },
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

let key = "";
const tick = () => new Promise((r) => setTimeout(r, 5));

async function post(body: Record<string, unknown>) {
  const res = await POST(
    new Request("https://app.test/api/v1/deals", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  await tick();
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function patch(id: string, body: Record<string, unknown>) {
  const res = await PATCH(
    new Request(`https://app.test/api/v1/deals/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  await tick();
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const dealOf = (json: Record<string, unknown>) => json.deal as Record<string, unknown>;

beforeEach(() => {
  mem.clear();
  webhooks.length = 0;
  mem.seed("subAccounts/sa1", { name: "SA", agencyId: "ag1", apiAccessEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann" });
  mem.seed("subAccounts/sa1/pipelines/p2", {
    name: "Renewals", isDefault: false, agencyId: "ag1", subAccountId: "sa1",
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "renewed", label: "Renewed", tone: "", terminal: "won" },
      { id: "churned", label: "Churned", tone: "", terminal: "lost" },
    ],
  });
  const k = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/key1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live", prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  key = k.rawKey;
});

const base = { title: "Deal", value: 10, currency: "USD", contact_id: "c1" };

describe("POST /api/v1/deals", () => {
  it("no pipeline_id ⇒ default pipeline, canonical stage, pipeline_id on the wire", async () => {
    const res = await post({ ...base, stage: "qualified" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(dealOf(res.json)).toMatchObject({ stage: "qualified", pipeline_id: "default" });
    expect(mem.read(`deals/${dealOf(res.json).id as string}`)?.pipelineId).toBe("default");
  });

  it("pipeline_id=p2 accepts p2's stages and refuses the default's", async () => {
    const ok = await post({ ...base, stage: "open", pipeline_id: "p2" });
    expect(ok.status).toBe(201);
    expect(dealOf(ok.json).pipeline_id).toBe("p2");

    const bad = await post({ ...base, stage: "qualified", pipeline_id: "p2" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toContain("open, renewed, churned");

    const missing = await post({ ...base, stage: "open", pipeline_id: "nope" });
    expect(missing.status).toBe(400);
    expect(mem.list("deals")).toHaveLength(1);
  });
});

describe("PATCH /api/v1/deals/:id", () => {
  it("validates stage against the deal's own pipeline", async () => {
    const created = await post({ ...base, stage: "open", pipeline_id: "p2" });
    const id = dealOf(created.json).id as string;
    // "won" is a default-pipeline id, not a p2 stage.
    const bad = await patch(id, { stage: "won" });
    expect(bad.status).toBe(400);
    expect(mem.read(`deals/${id}`)?.stageId).toBe("open");
  });

  it("won / lost webhooks come from the pipeline's terminal flags", async () => {
    const created = await post({ ...base, stage: "open", pipeline_id: "p2" });
    const id = dealOf(created.json).id as string;
    webhooks.length = 0;

    const won = await patch(id, { stage: "renewed" });
    expect(won.status).toBe(200);
    expect(webhooks).toEqual(["deal.updated", "deal.stage.changed", "deal.won"]);

    webhooks.length = 0;
    const lost = await patch(id, { stage: "churned" });
    expect(lost.status).toBe(200);
    expect(webhooks).toEqual(["deal.updated", "deal.stage.changed", "deal.lost"]);

    webhooks.length = 0;
    await patch(id, { stage: "open" });
    expect(webhooks).toEqual(["deal.updated", "deal.stage.changed"]);
  });

  it("a legacy deal with no pipelineId is validated against the default", async () => {
    mem.seed("deals/legacy", {
      ...base, contactId: "c1", stageId: "new", subAccountId: "sa1", agencyId: "ag1", mode: "live",
    });
    expect((await patch("legacy", { stage: "renewed" })).status).toBe(400);
    const ok = await patch("legacy", { stage: "won" });
    expect(ok.status).toBe(200);
    expect(dealOf(ok.json).pipeline_id).toBe("default");
    expect(webhooks).toContain("deal.won");
  });
});

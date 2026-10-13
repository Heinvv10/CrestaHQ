import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import {
  SAMPLE_CONTACT,
  SAMPLE_OPPS,
  SAMPLE_PIPELINES,
} from "@/lib/import/ghl/fixtures";

/**
 * GHL pipeline import end to end on fixtures: the real start route recreates
 * the GHL pipelines and stores the maps on the job, then the real drain step
 * lands each opportunity in its recreated pipeline. Only the edges are faked
 * — auth, QStash, the GHL HTTP client — and Firestore is in memory, so no
 * GHL account or live sub-account is touched.
 */

vi.mock("server-only", () => ({}));
const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u_admin" }),
}));
const publishCallback = vi.hoisted(() =>
  vi.fn(async (): Promise<{ messageId: string } | null> => ({ messageId: "m1" })),
);
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback,
}));
vi.mock("@/lib/server/sub-account-secrets", () => ({
  readSubAccountSecret: async () => "tok",
}));
vi.mock("@/lib/import/ghl/client", () => ({
  GhlApiError: class extends Error {},
  listContactsPage: async () => ({ items: [SAMPLE_CONTACT], next: null }),
  listOpportunitiesPage: async () => ({
    items: [
      ...SAMPLE_OPPS,
      // A pipeline the wizard did not send: squashes onto the default.
      { id: "O3", name: "Other", contactId: "C1", pipelineId: "pl_other", pipelineStageId: "x1", status: "open" },
    ],
    next: null,
  }),
  listContactNotes: async () => [],
}));

const { POST: start } = await import("./route");
const { POST: step } = await import("@/app/api/import/ghl/step/route");

const startImport = (body: Record<string, unknown>) =>
  start(
    new Request("https://app.test/api/sub-accounts/sa1/import/ghl/start", {
      method: "POST",
      body: JSON.stringify({
        mapping: { stageMap: { s_proposal: "proposal" }, defaultStage: "new", defaultCurrency: "ZAR", customFields: {} },
        entities: ["contacts", "opportunities"],
        ...body,
      }),
    }),
    { params: Promise.resolve({ id: "sa1" }) },
  );
const runStep = (jobId: string, entity: string) =>
  step(
    new Request("https://app.test/api/import/ghl/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ jobId, subAccountId: "sa1", entity }),
    }),
  );
const drain = async (jobId: string) => {
  expect((await runStep(jobId, "contacts")).status).toBe(200);
  expect((await runStep(jobId, "opportunities")).status).toBe(200);
};
const dealsByTitle = () =>
  Object.fromEntries(mem.list("deals").map((d) => [d.title, [d.pipelineId, d.stageId]]));

beforeEach(() => {
  publishCallback.mockClear();
  mem.clear();
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    ghlImportConfig: { locationId: "loc1" },
  });
});

describe("GHL import with createPipelines", () => {
  it("recreates the fixture pipeline and lands every opportunity in it", async () => {
    const res = await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES });
    const body = (await res.json()) as { ok: boolean; jobId: string; pipelinesCreated: number };
    expect(body).toMatchObject({ ok: true, pipelinesCreated: 1 });
    expect(body).not.toHaveProperty("pipelineWarnings");

    const pipelines = mem.list("subAccounts/sa1/pipelines");
    expect(pipelines.map((p) => p.name)).toEqual(["Sales"]);
    const salesId = pipelines[0].id;
    expect(mem.read(`importJobs/${body.jobId}`)?.ghlMapping).toMatchObject({
      pipelineMap: { pl_sales: { id: salesId, stageIds: { s_proposal: "proposal_sent" } } },
    });

    await drain(body.jobId);
    expect(dealsByTitle()).toEqual({
      "Website rebuild": [salesId, "proposal_sent"],
      "Won deal": [salesId, "won"],
      Other: ["default", "new"],
    });
    expect(mem.read(`importJobs/${body.jobId}`)?.status).toBe("completed");
  });

  it("unticked: creates no pipeline and squashes every deal onto the default", async () => {
    const res = await startImport({ createPipelines: false, ghlPipelines: SAMPLE_PIPELINES });
    const body = (await res.json()) as { jobId: string; pipelinesCreated: number };
    expect(body.pipelinesCreated).toBe(0);
    expect(mem.list("subAccounts/sa1/pipelines")).toEqual([]);
    expect(mem.read(`importJobs/${body.jobId}`)?.ghlMapping).not.toHaveProperty("pipelineMap");

    await drain(body.jobId);
    expect(dealsByTitle()).toEqual({
      "Website rebuild": ["default", "proposal"],
      "Won deal": ["default", "won"],
      Other: ["default", "new"],
    });
  });

  it("returns the warnings for a pipeline it could not recreate", async () => {
    const res = await startImport({
      createPipelines: true,
      ghlPipelines: [...SAMPLE_PIPELINES, { id: "bad/id", name: "Broken", stages: [] }],
    });
    const body = (await res.json()) as { pipelinesCreated: number; pipelineWarnings?: string[] };
    expect(body.pipelinesCreated).toBe(1);
    expect(body.pipelineWarnings).toEqual([expect.stringContaining('"Broken"')]);
  });

  it("a second run reuses the pipeline: same deal pipelines and stages, no new stage-history rows", async () => {
    const run = async () => {
      const body = (await (
        await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })
      ).json()) as { jobId: string; pipelinesCreated: number };
      expect(body.pipelinesCreated).toBe(1);
      await drain(body.jobId);
    };
    await run();
    const deals = dealsByTitle();
    const rows = mem.list("dealStageHistory").length;
    expect(rows).toBe(3);

    await run();
    expect(mem.list("subAccounts/sa1/pipelines").map((p) => p.id)).toEqual(["ghl_pl_sales"]);
    expect(mem.list("deals")).toHaveLength(3);
    expect(dealsByTitle()).toEqual(deals);
    expect(mem.list("dealStageHistory")).toHaveLength(rows);
  });

  it("a retry after the enqueue failed reuses the pipeline the failed start created", async () => {
    publishCallback.mockResolvedValueOnce(null);
    const failed = await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES });
    expect(failed.status).toBe(502);
    expect(mem.list("subAccounts/sa1/pipelines")).toHaveLength(1);

    const body = (await (
      await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })
    ).json()) as { jobId: string };
    expect(mem.list("subAccounts/sa1/pipelines").map((p) => p.id)).toEqual(["ghl_pl_sales"]);
    await drain(body.jobId);
    expect(dealsByTitle()["Website rebuild"]).toEqual(["ghl_pl_sales", "proposal_sent"]);
  });
});

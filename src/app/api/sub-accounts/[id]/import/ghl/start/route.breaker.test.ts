import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { SAMPLE_CONTACT, SAMPLE_OPPS, SAMPLE_PIPELINES } from "@/lib/import/ghl/fixtures";

/**
 * Adversarial GHL pipeline imports (breaker round on #402): re-runs, failed
 * starts, outcome-named stages, shared stage ids, prototype-named ids,
 * oversize input. Real start + drain routes, in-memory Firestore, fixtures
 * only — no GHL account, no live sub-account.
 */

vi.mock("server-only", () => ({}));
const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u_admin" }),
}));
const publish = vi.hoisted(() =>
  vi.fn(async (): Promise<{ messageId: string } | null> => ({ messageId: "m1" })),
);
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback: publish,
}));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "tok" }));
const ghl = vi.hoisted(() => ({ opps: [] as unknown[] }));
vi.mock("@/lib/import/ghl/client", () => ({
  GhlApiError: class extends Error {},
  listContactsPage: async () => ({ items: [SAMPLE_CONTACT], next: null }),
  listOpportunitiesPage: async () => ({ items: ghl.opps, next: null }),
  listContactNotes: async () => [],
}));

const { POST: start } = await import("./route");
const { POST: step } = await import("@/app/api/import/ghl/step/route");
const { dealOutcome } = await import("@/lib/pipelines/stages");

type Stage = { id: string; label: string; tone: string; terminal?: "won" | "lost" };
type StartBody = { jobId: string; pipelinesCreated: number; pipelineWarnings?: string[] };

const startImport = (body: Record<string, unknown>) =>
  start(
    new Request("https://app.test/api/sub-accounts/sa1/import/ghl/start", {
      method: "POST",
      body: JSON.stringify({
        mapping: { stageMap: {}, defaultStage: "new", defaultCurrency: "ZAR", customFields: {} },
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
const pipelines = () => mem.list("subAccounts/sa1/pipelines") as unknown as Array<{ id: string; name: string; stages: Stage[] }>;

beforeEach(() => {
  mem.clear();
  publish.mockReset();
  publish.mockImplementation(async () => ({ messageId: "m1" }));
  ghl.opps = SAMPLE_OPPS;
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ghlImportConfig: { locationId: "loc1" } });
});

describe("GHL pipeline import — breaker cases", () => {
  it("A1: re-import with createPipelines twice leaves one pipeline set", async () => {
    for (let i = 0; i < 2; i++) {
      const j = (await (await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })).json()) as StartBody;
      await drain(j.jobId);
    }
    expect(pipelines()).toHaveLength(1);
    expect(mem.list("deals").every((d) => d.pipelineId === "ghl_pl_sales")).toBe(true);
  });

  it("A2: a start whose enqueue fails, then a retry, leaves one pipeline set", async () => {
    publish.mockImplementationOnce(async () => null);
    expect((await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })).status).toBe(502);
    expect((await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })).status).toBe(200);
    expect(pipelines()).toHaveLength(1);
  });

  it("A2: a start whose job write throws, then a retry, leaves one pipeline set", async () => {
    const realCollection = mem.db.collection;
    let fail = true;
    mem.db.collection = ((path: string) => {
      const col = realCollection(path);
      if (path !== "importJobs" || !fail) return col;
      fail = false;
      return {
        ...col,
        doc: () => ({ ...col.doc(), set: async () => { throw new Error("write failed"); } }),
      };
    }) as typeof realCollection;
    try {
      await expect(startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })).rejects.toThrow("write failed");
      expect(pipelines()).toHaveLength(1);
      expect((await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES })).status).toBe(200);
    } finally {
      mem.db.collection = realCollection;
    }
    expect(pipelines()).toHaveLength(1);
  });

  it("A3: GHL stages New / Won / Lost give three stages, and a deal on GHL 'Won' is won", async () => {
    const pl = [{ id: "pl_x", name: "X", stages: [{ id: "s_a", name: "New" }, { id: "s_w", name: "Won" }, { id: "s_l", name: "Lost" }] }];
    ghl.opps = [{ id: "O1", name: "On Won", contactId: "C1", pipelineId: "pl_x", pipelineStageId: "s_w", status: "open" }];
    const j = (await (await startImport({ createPipelines: true, ghlPipelines: pl })).json()) as StartBody;
    await drain(j.jobId);
    const [p] = pipelines();
    expect(p.stages.map((s) => [s.label, s.terminal])).toEqual([
      ["New", undefined],
      ["Won", "won"],
      ["Lost", "lost"],
    ]);
    const d = mem.list("deals")[0] as unknown as { pipelineId: string; stageId: string };
    expect(dealOutcome(d, [p])).toBe("won");
  });

  it("A4: two GHL pipelines sharing a stage id keep their own mappings", async () => {
    const pl = [
      { id: "pA", name: "A", stages: [{ id: "s1", name: "Intro" }, { id: "dup", name: "Demo" }] },
      { id: "pB", name: "B", stages: [{ id: "dup", name: "Other" }] },
    ];
    ghl.opps = [
      { id: "O1", name: "A deal", contactId: "C1", pipelineId: "pA", pipelineStageId: "dup", status: "open" },
      { id: "O2", name: "B deal", contactId: "C1", pipelineId: "pB", pipelineStageId: "dup", status: "open" },
    ];
    const j = (await (await startImport({ createPipelines: true, ghlPipelines: pl })).json()) as StartBody;
    await drain(j.jobId);
    expect(Object.fromEntries(mem.list("deals").map((d) => [d.title, [d.pipelineId, d.stageId]]))).toEqual({
      "A deal": ["ghl_pA", "demo"],
      "B deal": ["ghl_pB", "other"],
    });
  });

  it("A5: prototype-named, path, dot and oversize ids never strand a deal off its pipeline's stages", async () => {
    const pl = [
      { id: "constructor", name: "Ctor", stages: [{ id: "toString", name: "S" }] },
      { id: "__proto__", name: "Proto", stages: [] },
      { id: "..", name: "Dots", stages: [] },
      { id: "a/b", name: "Slash", stages: [] },
      { id: "x".repeat(1501), name: "Long", stages: [] },
      { id: "constructor", name: "Dup", stages: [] },
      { id: "hasOwnProperty", name: "HOP", stages: [] },
    ];
    ghl.opps = [
      { id: "O1", name: "ctor deal", contactId: "C1", pipelineId: "constructor", pipelineStageId: "toString", status: "open" },
      { id: "O2", name: "proto deal", contactId: "C1", pipelineId: "__proto__", pipelineStageId: "valueOf", status: "open" },
      { id: "O3", name: "tostring deal", contactId: "C1", pipelineId: "toString", pipelineStageId: "constructor", status: "open" },
    ];
    const j = (await (await startImport({ createPipelines: true, ghlPipelines: pl })).json()) as StartBody;
    expect(pipelines().map((p) => p.name).sort()).toEqual(["Ctor", "HOP"]);
    expect(j.pipelineWarnings).toHaveLength(5);
    await drain(j.jobId);
    expect(mem.list("deals")).toHaveLength(3);
    for (const d of mem.list("deals")) {
      const stages =
        d.pipelineId === "default"
          ? ["new", "contacted", "qualified", "proposal", "won", "lost"]
          : (mem.read(`subAccounts/sa1/pipelines/${d.pipelineId}`)?.stages as Stage[]).map((s) => s.id);
      expect(stages).toContain(d.stageId);
    }
  });

  it("A6: over 25 pipelines and 20 stages, blank / unicode / emoji-cut names", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      name: i === 0 ? "   " : i === 1 ? "日本語パイプライン" : `P${i}`,
      stages: Array.from({ length: 25 }, (_, k) => ({
        id: `p${i}s${k}`,
        name: k === 0 ? "" : k === 1 ? "статус" : k === 2 ? `${"a".repeat(39)}😀` : `Stage ${k}`,
      })),
    }));
    ghl.opps = [
      { id: "O1", name: "late stage", contactId: "C1", pipelineId: "p2", pipelineStageId: "p2s24", status: "open" },
      { id: "O2", name: "p29", contactId: "C1", pipelineId: "p29", pipelineStageId: "p29s3", status: "open" },
      { id: "O3", name: "abandoned", contactId: "C1", pipelineId: "p2", pipelineStageId: "p2s3", status: "abandoned" },
    ];
    const j = (await (await startImport({ createPipelines: true, ghlPipelines: many })).json()) as StartBody;
    expect(j.pipelinesCreated).toBe(24); // first 25, minus the blank name
    expect(pipelines()).toHaveLength(24);
    const p1 = pipelines().find((p) => p.name === "日本語パイプライン")!;
    expect(p1.stages).toHaveLength(20);
    expect(p1.stages[0]).toMatchObject({ id: "stage_2", label: "статус" });
    const cut = p1.stages.find((s) => s.label.startsWith("aaaa"))!.label;
    expect(cut).toBe("a".repeat(39));
    expect(cut.isWellFormed()).toBe(true);
    await drain(j.jobId);
    expect(Object.fromEntries(mem.list("deals").map((d) => [d.title, [d.pipelineId, d.stageId]]))).toEqual({
      "late stage": ["ghl_p2", "stage_2"], // dropped GHL stage → the pipeline's first stage
      p29: ["default", "new"], // pipeline 30 of 30: not recreated
      abandoned: ["ghl_p2", "lost"],
    });
  });

  it("#9: no pipelines are created when the import doesn't pull opportunities", async () => {
    const j = (await (
      await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES, entities: ["contacts", "notes"] })
    ).json()) as StartBody;
    expect(j.pipelinesCreated).toBe(0);
    expect(pipelines()).toEqual([]);
  });
});

describe("GHL pipeline import — breaker round 2", () => {
  const opp = (id: string, pipelineId: string, pipelineStageId: string, status = "open") => ({
    id, name: id, contactId: "C1", pipelineId, pipelineStageId, status,
  });
  const deals = () => mem.list("deals").map((d) => [d.title, d.pipelineId, d.stageId]);
  const moveRows = () => mem.list("dealStageHistory").filter((r) => r.fromStageId !== null);
  const run = async (pl: unknown, extra: Record<string, unknown> = {}) => {
    const res = await startImport({ createPipelines: true, ghlPipelines: pl, ...extra });
    const j = (await res.json()) as StartBody;
    expect(res.status).toBe(200);
    await drain(j.jobId);
    return j;
  };
  const SALES = "subAccounts/sa1/pipelines/ghl_pl_sales";

  it("N2: a stage the operator deleted is not re-added by a re-import; its deals land on the first stage", async () => {
    ghl.opps = [opp("O1", "pl_sales", "s_proposal")];
    await run(SAMPLE_PIPELINES);
    const p = mem.read(SALES)!;
    mem.seed(SALES, { ...p, stages: (p.stages as Stage[]).filter((s) => s.id !== "contacted") });
    ghl.opps = [opp("O1", "pl_sales", "s_proposal"), opp("O2", "pl_sales", "s_contacted")];
    const j = await run(SAMPLE_PIPELINES);
    expect((mem.read(SALES)!.stages as Stage[]).map((s) => s.id)).not.toContain("contacted");
    expect(deals()).toEqual(expect.arrayContaining([["O2", "ghl_pl_sales", "new_lead"]]));
    expect(j.pipelineWarnings).toEqual([expect.stringContaining("1 GoHighLevel stage couldn't be added")]);
  });

  describe("N3: a re-import that can't update an imported pipeline leaves its deals where they are", () => {
    const firstRun = async () => {
      ghl.opps = [opp("O1", "pl_sales", "s_proposal")];
      await run(SAMPLE_PIPELINES);
      expect(deals()).toEqual([["O1", "ghl_pl_sales", "proposal_sent"]]);
    };
    const unchanged = (j: StartBody) => {
      expect(deals()).toEqual([["O1", "ghl_pl_sales", "proposal_sent"]]);
      expect(moveRows()).toEqual([]);
      expect(j.pipelineWarnings).toEqual(
        expect.arrayContaining([expect.stringContaining("couldn't be updated")]),
      );
    };

    it("no room for the stages it needs (20 stages, Won removed)", async () => {
      await firstRun();
      const p = mem.read(SALES)!;
      const open = (p.stages as Stage[]).filter((s) => !s.terminal && s.id !== "contacted");
      const filler = Array.from({ length: 19 - open.length }, (_, i) => ({ id: `extra_${i}`, label: `Extra ${i}`, tone: "" }));
      mem.seed(SALES, { ...p, stages: [...open, ...filler, (p.stages as Stage[]).find((s) => s.terminal === "lost")] });
      unchanged(await run(SAMPLE_PIPELINES));
      expect(mem.read(SALES)!.stages).toHaveLength(20);
    });

    it("the GHL pipeline's name is now blank", async () => {
      await firstRun();
      unchanged(await run([{ ...SAMPLE_PIPELINES[0], name: "   " }]));
    });

    it(`it shifted past the ${25}-pipeline cap`, async () => {
      await firstRun();
      const others = Array.from({ length: 25 }, (_, i) => ({ id: `other${i}`, name: `Other ${i}`, stages: [] }));
      unchanged(await run([...others, SAMPLE_PIPELINES[0]]));
    });

    it("the update transaction fails", async () => {
      await firstRun();
      const realTx = mem.db.runTransaction;
      mem.db.runTransaction = (async () => {
        throw new Error("10 ABORTED: contention");
      }) as unknown as typeof realTx;
      vi.spyOn(console, "error").mockImplementation(() => {});
      let j: StartBody;
      try {
        const res = await startImport({ createPipelines: true, ghlPipelines: SAMPLE_PIPELINES });
        j = (await res.json()) as StartBody;
      } finally {
        mem.db.runTransaction = realTx;
      }
      await drain(j.jobId);
      unchanged(j);
    });

    it("but with no earlier import, a pipeline that can't be created still falls back to the default", async () => {
      ghl.opps = [opp("O1", "pl_sales", "s_proposal")];
      const j = await run([{ ...SAMPLE_PIPELINES[0], name: "   " }]);
      expect(deals()).toEqual([["O1", "default", "new"]]);
      expect(j.pipelineWarnings).toEqual([expect.stringContaining("onto the default pipeline")]);
    });
  });

  it("N5: GHL ids containing ':' don't collide", async () => {
    const pl = [
      { id: "a:b", name: "AB", stages: [{ id: "first", name: "First" }, { id: "c", name: "Target C" }] },
      { id: "a", name: "A", stages: [{ id: "first2", name: "First" }, { id: "b:c", name: "Target BC" }] },
    ];
    ghl.opps = [opp("O1", "a:b", "c"), opp("O2", "a", "b:c")];
    await run(pl);
    expect(deals()).toEqual(
      expect.arrayContaining([
        ["O1", "ghl_a:b", "target_c"],
        ["O2", "ghl_a", "target_bc"],
      ]),
    );
  });

  it("N8: legacy path on a customised default pipeline uses its own stages and terminals", async () => {
    mem.seed("subAccounts/sa1/pipelines/default", {
      name: "Default", isDefault: true, subAccountId: "sa1", agencyId: "ag1",
      stages: [
        { id: "site_survey", label: "Site survey", tone: "" },
        { id: "install", label: "Install", tone: "" },
        { id: "signed", label: "Signed", tone: "", terminal: "won" },
        { id: "dead", label: "Dead", tone: "", terminal: "lost" },
      ],
    });
    ghl.opps = [opp("O1", "pl_sales", "s_contacted"), opp("O2", "pl_sales", "s_new", "won"), opp("O3", "pl_sales", "s_new", "lost")];
    const res = await startImport({
      createPipelines: false,
      mapping: { stageMap: {}, defaultStage: "install", defaultCurrency: "ZAR", customFields: {} },
    });
    const j = (await res.json()) as StartBody;
    await drain(j.jobId);
    expect(deals()).toEqual([
      ["O1", "default", "install"],
      ["O2", "default", "signed"],
      ["O3", "default", "dead"],
    ]);

    // A default stage that isn't on the default pipeline falls back to its first open stage.
    const res2 = await startImport({
      createPipelines: false,
      mapping: { stageMap: {}, defaultStage: "new", defaultCurrency: "ZAR", customFields: {} },
    });
    const j2 = (await res2.json()) as StartBody;
    expect(mem.read(`importJobs/${j2.jobId}`)?.ghlMapping).toMatchObject({
      defaultStage: "site_survey",
      defaultWonId: "signed",
      defaultLostId: "dead",
    });
  });

  it("N9: a GHL id that fits a doc id but not with the ghl_ prefix is refused, not thrown", async () => {
    const id = "x".repeat(1498);
    ghl.opps = [opp("O1", id, "s1")];
    const j = await run([{ id, name: "Long", stages: [{ id: "s1", name: "S" }] }]);
    expect(pipelines()).toEqual([]);
    expect(j.pipelineWarnings).toEqual([expect.stringContaining("invalid or duplicate id")]);
    expect(deals()).toEqual([["O1", "default", "new"]]);
  });
});

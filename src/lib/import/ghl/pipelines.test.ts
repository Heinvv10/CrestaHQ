import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { SAMPLE_PIPELINES } from "@/lib/import/ghl/fixtures";

/**
 * GHL pipeline import: every GHL pipeline the wizard sends becomes a pipeline
 * in this sub-account with its stage names + Won/Lost, and the maps the drain
 * lands opportunities with point at the stored stage ids. Fixtures only — an
 * in-memory Firestore, no GHL account and no live sub-account.
 */

vi.mock("server-only", () => ({}));
const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { mergeImportedStages, recreateGhlPipelines, MAX_IMPORTED_PIPELINES } = await import("./pipelines");

const pipelineDocs = () =>
  mem.list("subAccounts/sa1/pipelines") as unknown as Array<{
    id: string;
    name: string;
    stages: Array<{ id: string; label: string; terminal?: string }>;
    agencyId: string;
    subAccountId: string;
    createdByUid: string;
    isDefault: boolean;
  }>;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recreateGhlPipelines", () => {
  it("creates one pipeline per GHL pipeline from the fixtures, with its stages + Won/Lost", async () => {
    const r = await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    expect(r.warnings).toEqual([]);
    const [doc] = pipelineDocs();
    expect(pipelineDocs()).toHaveLength(1);
    expect(doc).toMatchObject({
      name: "Sales",
      isDefault: false,
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "u1",
    });
    expect(doc.stages.map((s) => [s.id, s.label, s.terminal])).toEqual([
      ["new_lead", "New Lead", undefined],
      ["contacted", "Contacted", undefined],
      ["proposal_sent", "Proposal Sent", undefined],
      ["won", "Won", "won"],
      ["lost", "Lost", "lost"],
    ]);
    expect(r.pipelineMap).toEqual({
      pl_sales: { id: doc.id, firstId: "new_lead", wonId: "won", lostId: "lost" },
    });
    expect(r.pipelineStageMap).toEqual({
      "pl_sales:s_new": { pipelineId: doc.id, stageId: "new_lead" },
      "pl_sales:s_contacted": { pipelineId: doc.id, stageId: "contacted" },
      "pl_sales:s_proposal": { pipelineId: doc.id, stageId: "proposal_sent" },
      // "Closed Won" / "Closed Lost" are outcomes: they land on the terminals.
      "pl_sales:s_won": { pipelineId: doc.id, stageId: "won" },
      "pl_sales:s_lost": { pipelineId: doc.id, stageId: "lost" },
    });
  });

  it("skips, with a warning, a pipeline whose id is not a doc id, whose name is blank, or that repeats", async () => {
    const r = await recreateGhlPipelines("sa1", "u1", [
      { id: "a/b", name: "Slash", stages: [] },
      { id: "__proto__", name: "Proto", stages: [] },
      { id: "p_blank", name: "   ", stages: [] },
      { id: "p_ok", name: "Ok", stages: [{ id: "s1", name: "One" }] },
      { id: "p_ok", name: "Ok again", stages: [] },
      "not an object",
    ]);
    expect(pipelineDocs().map((p) => p.name)).toEqual(["Ok"]);
    expect(Object.keys(r.pipelineMap)).toEqual(["p_ok"]);
    expect(r.warnings).toHaveLength(5);
  });

  it("creates nothing when the body carries no list", async () => {
    for (const body of [undefined, null, "x", { id: "p" }]) {
      const r = await recreateGhlPipelines("sa1", "u1", body);
      expect(r).toEqual({ pipelineMap: {}, pipelineStageMap: {}, warnings: [] });
    }
    expect(pipelineDocs()).toEqual([]);
  });

  it(`creates at most ${MAX_IMPORTED_PIPELINES} pipelines per request and says so`, async () => {
    const many = Array.from({ length: MAX_IMPORTED_PIPELINES + 3 }, (_, i) => ({
      id: `p${i}`,
      name: `Pipeline ${i}`,
      stages: [],
    }));
    const r = await recreateGhlPipelines("sa1", "u1", many);
    expect(pipelineDocs()).toHaveLength(MAX_IMPORTED_PIPELINES);
    expect(r.warnings).toEqual([
      expect.stringContaining(`first ${MAX_IMPORTED_PIPELINES} pipelines`),
    ]);
  });

  it("ignores a stage whose id is not a doc id; it is never mapped", async () => {
    const r = await recreateGhlPipelines("sa1", "u1", [
      { id: "p1", name: "P", stages: [{ id: "x/y", name: "Bad" }, { id: "s1", name: "Good" }] },
    ]);
    expect(pipelineDocs()[0].stages.map((s) => s.label)).toEqual(["Good", "Won", "Lost"]);
    expect(Object.keys(r.pipelineStageMap)).toEqual(["p1:s1"]);
  });

  it("reads at most 200 GHL stages of a pipeline", async () => {
    const stages = Array.from({ length: 300 }, (_, i) => ({ id: i < 200 ? "bad/id" : `s${i}`, name: `S${i}` }));
    const r = await recreateGhlPipelines("sa1", "u1", [{ id: "p1", name: "P", stages }]);
    expect(r.pipelineStageMap).toEqual({});
    expect(pipelineDocs()[0].stages.map((s) => s.id)).toEqual(["new", "won", "lost"]);
  });

  it("stores the GHL ids on the pipeline it creates", async () => {
    await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    expect(mem.read("subAccounts/sa1/pipelines/ghl_pl_sales")).toMatchObject({
      externalSource: "ghl",
      externalId: "pl_sales",
      externalStageIds: {
        s_new: "new_lead",
        s_contacted: "contacted",
        s_proposal: "proposal_sent",
        s_won: "won",
        s_lost: "lost",
      },
    });
  });

  it("a re-run reuses the pipeline and its stages and writes nothing", async () => {
    const first = await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    const before = mem.read("subAccounts/sa1/pipelines/ghl_pl_sales");
    const second = await recreateGhlPipelines("sa1", "u2", SAMPLE_PIPELINES);
    expect(second).toEqual(first);
    expect(pipelineDocs()).toHaveLength(1);
    expect(mem.read("subAccounts/sa1/pipelines/ghl_pl_sales")).toEqual(before);
  });

  it("a re-run keeps the operator's edits and adds only the GHL stage it has not seen", async () => {
    await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    const path = "subAccounts/sa1/pipelines/ghl_pl_sales";
    const doc = mem.read(path)!;
    const stages = doc.stages as Array<{ id: string; label: string }>;
    mem.seed(path, {
      ...doc,
      name: "My sales",
      stages: stages.map((s) => (s.id === "contacted" ? { ...s, label: "Spoke to them" } : s)),
    });
    const renamed = { ...SAMPLE_PIPELINES[0], name: "Sales (GHL)" };
    const r = await recreateGhlPipelines("sa1", "u1", [
      { ...renamed, stages: [...renamed.stages, { id: "s_nurture", name: "Nurture" }] },
    ]);
    const after = mem.read(path)!;
    expect(after.name).toBe("My sales");
    expect((after.stages as Array<{ id: string; label: string }>).map((s) => [s.id, s.label])).toEqual([
      ["new_lead", "New Lead"],
      ["contacted", "Spoke to them"],
      ["proposal_sent", "Proposal Sent"],
      ["nurture", "Nurture"],
      ["won", "Won"],
      ["lost", "Lost"],
    ]);
    expect(r.pipelineStageMap["pl_sales:s_nurture"]).toEqual({ pipelineId: "ghl_pl_sales", stageId: "nurture" });
    expect(r.pipelineStageMap["pl_sales:s_contacted"]).toEqual({ pipelineId: "ghl_pl_sales", stageId: "contacted" });
  });

  it("a pipeline the operator deleted is created again under the same id", async () => {
    await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    await mem.db.doc("subAccounts/sa1/pipelines/ghl_pl_sales").delete();
    const r = await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    expect(r.pipelineMap.pl_sales.id).toBe("ghl_pl_sales");
    expect(pipelineDocs()).toHaveLength(1);
  });

  it("two concurrent runs create the pipeline once", async () => {
    const [a, b] = await Promise.all([
      recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES),
      recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES),
    ]);
    expect(a).toEqual(b);
    expect(pipelineDocs()).toHaveLength(1);
  });

  it("concurrent re-runs that each bring a new GHL stage keep both", async () => {
    await recreateGhlPipelines("sa1", "u1", SAMPLE_PIPELINES);
    const withStage = (id: string, name: string) => [
      { ...SAMPLE_PIPELINES[0], stages: [...SAMPLE_PIPELINES[0].stages, { id, name }] },
    ];
    await Promise.all([
      recreateGhlPipelines("sa1", "u1", withStage("s_a", "Alpha")),
      recreateGhlPipelines("sa1", "u1", withStage("s_b", "Beta")),
    ]);
    const after = mem.read("subAccounts/sa1/pipelines/ghl_pl_sales")!;
    expect((after.stages as Array<{ id: string }>).map((s) => s.id)).toEqual(
      expect.arrayContaining(["alpha", "beta"]),
    );
    expect(after.externalStageIds).toMatchObject({ s_a: "alpha", s_b: "beta" });
  });

  it("warns and maps nothing when the sub-account is missing", async () => {
    const r = await recreateGhlPipelines("sa_gone", "u1", SAMPLE_PIPELINES);
    expect(r.pipelineMap).toEqual({});
    expect(r.warnings).toEqual([expect.stringContaining('"Sales" wasn\'t recreated')]);
  });
});

const named = (...names: string[]) => names.map((name, i) => ({ id: `g${i}`, name }));

describe("mergeImportedStages — a new pipeline", () => {
  it("keeps ids unique when names repeat", () => {
    const r = mergeImportedStages([], {}, named("Follow up", "Follow up"));
    expect(r.ok && r.value.stages.map((s) => [s.id, s.terminal])).toEqual([
      ["follow_up", undefined],
      ["follow_up_2", undefined],
      ["won", "won"],
      ["lost", "lost"],
    ]);
  });

  it("GHL stages named Won / Lost / Closed Won / Closed Lost map onto the terminals, not new open columns", () => {
    const r = mergeImportedStages([], {}, named("New", " WON ", "Lost", "Closed Won", "closed-lost"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stages.map((s) => [s.id, s.label, s.terminal])).toEqual([
      ["new", "New", undefined],
      ["won", "Won", "won"],
      ["lost", "Lost", "lost"],
    ]);
    expect(r.value.byGhlId).toEqual({ g0: "new", g1: "won", g2: "lost", g3: "won", g4: "lost" });
    expect(r.value.dropped).toBe(0);
  });

  it("a Won-named GHL stage maps onto an existing pipeline's own Won, whatever its id", () => {
    const r = mergeImportedStages(
      [
        { id: "a", label: "A", tone: "" },
        { id: "signed", label: "Signed", tone: "", terminal: "won" },
        { id: "dead", label: "Dead", tone: "", terminal: "lost" },
      ],
      {},
      named("Won", "Lost"),
    );
    expect(r.ok && r.value.byGhlId).toEqual({ g0: "signed", g1: "dead" });
    expect(r.ok && r.value.stages.map((s) => s.id)).toEqual(["a", "signed", "dead"]);
  });

  it("cuts a long label on a code point, never inside an emoji", () => {
    const r = mergeImportedStages([], {}, named(`${"a".repeat(39)}😀`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const label = r.value.stages[0].label;
    expect(label).toBe("a".repeat(39));
    expect(label.isWellFormed()).toBe(true);
  });

  it("gives a name with no latin characters a positional id", () => {
    const r = mergeImportedStages([], {}, named("Новый", "Готово"));
    expect(r.ok && r.value.stages.map((s) => [s.id, s.label])).toEqual([
      ["stage_1", "Новый"],
      ["stage_2", "Готово"],
      ["won", "Won"],
      ["lost", "Lost"],
    ]);
  });

  it("keeps the first 18 named stages (20 with Won/Lost) and counts the rest as dropped", () => {
    const r = mergeImportedStages([], {}, named(...Array.from({ length: 22 }, (_, i) => (i === 0 ? "  " : `Stage ${i}`))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stages).toHaveLength(20);
    expect(r.value.byGhlId).not.toHaveProperty("g0");
    expect(Object.keys(r.value.byGhlId)).toHaveLength(18);
    expect(r.value.dropped).toBe(4);
  });

  it("an empty GHL pipeline still gets an open stage before Won/Lost", () => {
    const r = mergeImportedStages([], {}, []);
    expect(r.ok && r.value.stages.map((s) => s.id)).toEqual(["new", "won", "lost"]);
  });
});

describe("mergeImportedStages — an existing pipeline", () => {
  const current = [
    { id: "a", label: "Renamed A", tone: "" },
    { id: "b", label: "B", tone: "" },
    { id: "won", label: "Won", tone: "", terminal: "won" as const },
    { id: "lost", label: "Lost", tone: "", terminal: "lost" as const },
  ];

  it("keeps known stages (and the operator's labels), adds only new GHL stages before Won", () => {
    const r = mergeImportedStages(current, { g0: "a", g1: "b" }, named("A", "B", "C"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stages.map((s) => [s.id, s.label])).toEqual([
      ["a", "Renamed A"],
      ["b", "B"],
      ["c", "C"],
      ["won", "Won"],
      ["lost", "Lost"],
    ]);
    expect(r.value.byGhlId).toEqual({ g0: "a", g1: "b", g2: "c" });
  });

  it("a known stage the operator deleted is added again; nothing is matched by position", () => {
    const r = mergeImportedStages(current, { g0: "gone" }, [{ id: "g0", name: "A" }, { id: "g9", name: "B" }]);
    expect(r.ok && r.value.stages.map((s) => s.id)).toEqual(["a", "b", "a_2", "b_2", "won", "lost"]);
  });

  it("appends Won/Lost the operator removed, and drops GHL stages with no room left", () => {
    const open = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `S${i}`, tone: "" }));
    const r = mergeImportedStages(open(17), {}, named("X", "Y"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stages.slice(-3).map((s) => [s.id, s.terminal])).toEqual([
      ["x", undefined],
      ["won", "won"],
      ["lost", "lost"],
    ]);
    expect(r.value.stages).toHaveLength(20);
    expect(r.value.dropped).toBe(1);
    // No room even for the terminals: refused, never a pipeline without Won/Lost.
    expect(mergeImportedStages(open(19), {}, []).ok).toBe(false);
  });
});

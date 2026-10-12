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

const { importedStages, recreateGhlPipelines, MAX_IMPORTED_PIPELINES } = await import("./pipelines");

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
      ["closed_won", "Closed Won", undefined],
      ["closed_lost", "Closed Lost", undefined],
      ["won", "Won", "won"],
      ["lost", "Lost", "lost"],
    ]);
    expect(r.pipelineMap).toEqual({
      pl_sales: { id: doc.id, firstId: "new_lead", wonId: "won", lostId: "lost" },
    });
    expect(r.pipelineStageMap).toEqual({
      s_new: { pipelineId: doc.id, stageId: "new_lead" },
      s_contacted: { pipelineId: doc.id, stageId: "contacted" },
      s_proposal: { pipelineId: doc.id, stageId: "proposal_sent" },
      s_won: { pipelineId: doc.id, stageId: "closed_won" },
      s_lost: { pipelineId: doc.id, stageId: "closed_lost" },
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
    expect(Object.keys(r.pipelineStageMap)).toEqual(["s1"]);
  });

  it("warns and maps nothing when the sub-account is missing", async () => {
    const r = await recreateGhlPipelines("sa_gone", "u1", SAMPLE_PIPELINES);
    expect(r.pipelineMap).toEqual({});
    expect(r.warnings).toEqual([expect.stringContaining('"Sales" wasn\'t recreated')]);
  });
});

describe("importedStages", () => {
  it("keeps ids unique when a GHL stage is itself called Won / Lost or names repeat", () => {
    const r = importedStages(["Won", "Lost", "Follow up", "Follow up"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stages.map((s) => [s.id, s.terminal])).toEqual([
      ["won", undefined],
      ["lost", undefined],
      ["follow_up", undefined],
      ["follow_up_2", undefined],
      ["won_2", "won"],
      ["lost_2", "lost"],
    ]);
    expect(r.value.ids).toEqual(["won", "lost", "follow_up", "follow_up_2"]);
  });

  it("gives a name with no latin characters a positional id", () => {
    const r = importedStages(["Новый", "Готово"]);
    expect(r.ok && r.value.stages.map((s) => [s.id, s.label])).toEqual([
      ["stage_1", "Новый"],
      ["stage_2", "Готово"],
      ["won", "Won"],
      ["lost", "Lost"],
    ]);
  });

  it("keeps the first 18 named stages (20 with Won/Lost) and leaves the rest unmapped", () => {
    const names = Array.from({ length: 22 }, (_, i) => (i === 0 ? "  " : `Stage ${i}`));
    const r = importedStages(names);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stages).toHaveLength(20);
    expect(r.value.ids[0]).toBeUndefined();
    expect(r.value.ids.filter(Boolean)).toHaveLength(18);
    expect(r.value.ids.slice(19)).toEqual([undefined, undefined, undefined]);
  });

  it("an empty GHL pipeline still gets an open stage before Won/Lost", () => {
    const r = importedStages([]);
    expect(r.ok && r.value.stages.map((s) => s.id)).toEqual(["new", "won", "lost"]);
  });
});

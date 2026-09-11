import { describe, expect, it } from "vitest";
import { dealOutcome, validateStages } from "./stages";
import { PIPELINE_STAGES } from "@/types/deals";

const pipelines = [
  { id: "default", stages: PIPELINE_STAGES },
  {
    id: "p2",
    stages: [
      { id: "open", label: "Open", tone: "" },
      { id: "renewed", label: "Renewed", tone: "", terminal: "won" as const },
      { id: "won", label: "Not actually won", tone: "" },
    ],
  },
];

describe("dealOutcome", () => {
  it("default pipeline (absent pipelineId): won/lost by the canonical terminals", () => {
    expect(dealOutcome({ stageId: "won" }, pipelines)).toBe("won");
    expect(dealOutcome({ stageId: "lost" }, pipelines)).toBe("lost");
    expect(dealOutcome({ stageId: "proposal" }, pipelines)).toBe("open");
  });

  it("another pipeline: by ITS terminal flags, not the literal ids", () => {
    expect(dealOutcome({ pipelineId: "p2", stageId: "renewed" }, pipelines)).toBe("won");
    // "won" is an OPEN stage on p2.
    expect(dealOutcome({ pipelineId: "p2", stageId: "won" }, pipelines)).toBe("open");
    expect(dealOutcome({ pipelineId: "p2", stageId: "open" }, pipelines)).toBe("open");
  });

  it("unknown pipeline or stage counts as open", () => {
    expect(dealOutcome({ pipelineId: "gone", stageId: "won" }, pipelines)).toBe("open");
    expect(dealOutcome({ stageId: "deleted_stage" }, pipelines)).toBe("open");
  });
});

describe("validateStages", () => {
  it("keeps ids, slugs new labels, and caps one won + one lost", () => {
    const ok = validateStages([
      { id: "keep_me", label: "Renamed" },
      { label: "Needs Review!" },
      { label: "Done", terminal: "won" },
    ]);
    expect(ok.ok && ok.value.map((s) => s.id)).toEqual(["keep_me", "needs_review", "done"]);
    expect(validateStages([{ label: "A", terminal: "won" }, { label: "B", terminal: "won" }]).ok).toBe(false);
    expect(validateStages([{ label: "A" }, { label: "a" }]).ok).toBe(false);
    expect(validateStages([]).ok).toBe(false);
  });
});

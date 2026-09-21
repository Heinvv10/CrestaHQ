import { describe, expect, it } from "vitest";
import { computeStageHistoryReport, median, type HistoryRow } from "./stage-history";

/** The route test reconciles the full fixture; these pin the two edge rules. */

const stages = [
  { id: "new", label: "New", tone: "" },
  { id: "won", label: "Won", tone: "", terminal: "won" as const },
];
const r = (p: Partial<HistoryRow>): HistoryRow => ({
  dealId: "d", source: "app", pipelineId: "default", stageId: "new",
  fromPipelineId: null, fromStageId: null, fromStageEnteredAtMs: null, enteredAtMs: 0, ...p,
});

describe("stage history maths", () => {
  it("median: empty is null, odd takes the middle, even averages the two middles", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("velocity times a deal won twice in range to its FIRST win", () => {
    const rows = [
      r({ stageId: "won", fromPipelineId: "default", fromStageId: "new", fromStageEnteredAtMs: 0, enteredAtMs: 10 }),
      r({ stageId: "new", fromPipelineId: "default", fromStageId: "won", fromStageEnteredAtMs: 10, enteredAtMs: 20 }),
      r({ stageId: "won", fromPipelineId: "default", fromStageId: "new", fromStageEnteredAtMs: 20, enteredAtMs: 30 }),
    ];
    const report = computeStageHistoryReport("default", stages, rows, new Map([["d", 0]]));
    expect(report.velocity).toEqual({ won: 1, withCreation: 1, medianMs: 10 });
  });
});

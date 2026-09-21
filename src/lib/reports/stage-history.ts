import type { PipelineStage } from "@/types/deals";

/**
 * Stage-history report maths (W3 PR2): pure, no Firestore. The route reads
 * the rows (tenancy, live mode, territory scope, date range) and hands them
 * here. Every number is defined so it can be reconciled by counting rows:
 * docs/programme/w3-stage-history.md "Report definitions".
 */

/** A `dealStageHistory` row with its timestamps as epoch ms. */
export interface HistoryRow {
  dealId: string;
  source: string;
  pipelineId: string;
  stageId: string;
  fromPipelineId: string | null;
  fromStageId: string | null;
  fromStageEnteredAtMs: number | null;
  enteredAtMs: number;
}

export interface StageStat {
  stageId: string;
  label: string;
  terminal: "won" | "lost" | null;
  /** Distinct deals that entered the stage inside the range. */
  entered: number;
  /** Stays in the stage that ENDED inside the range (a re-entry is a second stay). */
  completedStays: number;
  /** Median length of those stays; null when there are none. */
  medianMs: number | null;
  /** Deals that entered inside the range and had not left by its end. */
  stillIn: number;
  /** Of `entered`, how many later entered a stage further along (lost excluded). */
  advanced: number | null;
}

export interface StageHistoryReport {
  stages: StageStat[];
  velocity: {
    /** Distinct deals that entered a won stage of this pipeline in range. */
    won: number;
    /** Of those, how many have a recorded creation row (created after history began). */
    withCreation: number;
    /** Median creation → won; null when `withCreation` is 0. */
    medianMs: number | null;
  };
}

/** Rows whose timing is not when the stage changed; they only close an open stay. */
const TIMING_UNRELIABLE = new Set(["import"]);

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param rows every live row of the sub-account with `enteredAt` in range
 *   the caller may see, ANY pipeline and ANY source (import rows are needed
 *   to know a stay ended; they never contribute a duration or an entry).
 * @param creations dealId → the deal's creation-row `enteredAt`, for the
 *   deals won in range (the creation may predate the range).
 */
export function computeStageHistoryReport(
  pipelineId: string,
  stages: PipelineStage[],
  rows: HistoryRow[],
  creations: Map<string, number>,
): StageHistoryReport {
  const timed = rows.filter((r) => !TIMING_UNRELIABLE.has(r.source));

  // Latest row per deal in range, of any source: a deal whose latest row
  // entered stage S of this pipeline is still in S at range end.
  const latest = new Map<string, HistoryRow>();
  for (const r of rows) {
    const cur = latest.get(r.dealId);
    if (!cur || r.enteredAtMs >= cur.enteredAtMs) latest.set(r.dealId, r);
  }

  // Funnel order: the pipeline's stages, lost stages left out.
  const order = new Map<string, number>();
  stages.filter((s) => s.terminal !== "lost").forEach((s, i) => order.set(s.id, i));

  const out: StageStat[] = stages.map((stage) => {
    const stays = timed
      .filter(
        (r) =>
          r.fromPipelineId === pipelineId &&
          r.fromStageId === stage.id &&
          r.fromStageEnteredAtMs !== null,
      )
      .map((r) => r.enteredAtMs - (r.fromStageEnteredAtMs as number));

    // First entry per deal into this stage, in range.
    const firstEntry = new Map<string, number>();
    for (const r of timed) {
      if (r.pipelineId !== pipelineId || r.stageId !== stage.id) continue;
      const cur = firstEntry.get(r.dealId);
      if (cur === undefined || r.enteredAtMs < cur) firstEntry.set(r.dealId, r.enteredAtMs);
    }

    let stillIn = 0;
    for (const dealId of firstEntry.keys()) {
      const l = latest.get(dealId)!;
      if (l.pipelineId === pipelineId && l.stageId === stage.id) stillIn++;
    }

    const at = order.get(stage.id);
    let advanced: number | null = null;
    if (at !== undefined && at < order.size - 1) {
      advanced = 0;
      for (const [dealId, since] of firstEntry) {
        const moved = timed.some(
          (r) =>
            r.dealId === dealId &&
            r.pipelineId === pipelineId &&
            r.enteredAtMs > since &&
            (order.get(r.stageId) ?? -1) > at,
        );
        if (moved) advanced++;
      }
    }

    return {
      stageId: stage.id,
      label: stage.label,
      terminal: stage.terminal ?? null,
      entered: firstEntry.size,
      completedStays: stays.length,
      medianMs: median(stays),
      stillIn,
      advanced,
    };
  });

  const wonIds = new Set(stages.filter((s) => s.terminal === "won").map((s) => s.id));
  const firstWin = new Map<string, number>();
  for (const r of timed) {
    if (r.pipelineId !== pipelineId || !wonIds.has(r.stageId)) continue;
    const cur = firstWin.get(r.dealId);
    if (cur === undefined || r.enteredAtMs < cur) firstWin.set(r.dealId, r.enteredAtMs);
  }
  const cycles: number[] = [];
  for (const [dealId, wonAt] of firstWin) {
    const created = creations.get(dealId);
    if (created !== undefined) cycles.push(wonAt - created);
  }

  return {
    stages: out,
    velocity: { won: firstWin.size, withCreation: cycles.length, medianMs: median(cycles) },
  };
}

import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { dealPipelineId } from "@/lib/pipelines/stages";

/**
 * Deal stage history: one append-only row per stage entry, written in the
 * SAME commit (transaction or batch) as the deal write that caused it, so a
 * deal can never move without its row or gain a row it never made.
 *
 * A row is written when a deal is created (`fromStageId: null`) and whenever
 * its stageId or pipelineId changes. `enteredAt` is a server timestamp in
 * that commit, so it equals the deal's new `stageChangedAt` exactly.
 * `fromStageEnteredAt` is the deal's previous `stageChangedAt`, so one row
 * alone gives the time spent in the stage it left.
 *
 * Rows carry ids and timestamps only — no title, value or contact — and
 * outlive a deleted deal. Design + rejected alternatives:
 * docs/programme/w3-stage-history.md.
 */

export const DEAL_STAGE_HISTORY = "dealStageHistory";

/** Which entry point made the move — lets reports drop import/test noise. */
export type StageMoveSource =
  | "app" // dashboard routes (/api/deals)
  | "api" // public API v1
  | "workflow" // workflow move_stage step
  | "ai" // AI Suite capability
  | "quote" // quote accepted
  | "form" // public form submit
  | "import"; // bulk import

export interface StageEntry {
  /** The deal as it is AFTER the write: tenancy keys, mode, stage, pipeline. */
  dealId: string;
  deal: Record<string, unknown>;
  /** The deal BEFORE the write; null when it is being created. */
  previous: Record<string, unknown> | null;
  /** Who made the move (uid, `apikey:…`, or the workflow owner). */
  byUid: string;
  source: StageMoveSource;
}

interface Creator {
  create(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
  ): unknown;
}

/** Queue the history row on the commit that writes the deal. */
export function appendStageEntry(
  db: FirebaseFirestore.Firestore,
  commit: Creator,
  entry: StageEntry,
): void {
  const { deal, previous } = entry;
  commit.create(db.collection(DEAL_STAGE_HISTORY).doc(), {
    agencyId: deal.agencyId,
    subAccountId: deal.subAccountId,
    createdByUid: entry.byUid,
    mode: (deal.mode as string | undefined) ?? "live",
    source: entry.source,
    dealId: entry.dealId,
    pipelineId: dealPipelineId(deal),
    stageId: deal.stageId,
    fromPipelineId: previous ? dealPipelineId(previous) : null,
    fromStageId: (previous?.stageId as string | undefined) ?? null,
    fromStageEnteredAt: previous?.stageChangedAt ?? null,
    enteredAt: FieldValue.serverTimestamp(),
  });
}

import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import type { PipelineDoc, PipelineStage } from "@/types/deals";
import { countDeals } from "./server";

/**
 * Pipeline writes shared by the settings routes and the agent capabilities.
 * Inputs are already validated (validatePipelineName / validateStages); the
 * refusals carry the status and body the routes answer with.
 */

export type PipelineRefusal = { ok: false; status: number; error: string; stageId?: string; count?: number };

const pipelineRef = (subAccountId: string, pipelineId: string) =>
  getAdminDb().doc(`subAccounts/${subAccountId}/pipelines/${pipelineId}`);

/** Null when the sub-account doesn't exist. */
export async function createPipeline(opts: {
  subAccountId: string;
  createdByUid: string;
  name: string;
  stages: PipelineStage[];
  /** An API agent's write: stamped (see agentEditStamp). */
  actor?: AgentActor;
}): Promise<string | null> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  const agencyId = subSnap.data()?.agencyId as string | undefined;
  if (!subSnap.exists || !agencyId) return null;
  const ref = db.collection(`subAccounts/${opts.subAccountId}/pipelines`).doc();
  const doc: Omit<PipelineDoc, "id"> = {
    name: opts.name,
    stages: opts.stages,
    isDefault: false,
    agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set({ ...doc, ...agentEditStamp(opts.actor) });
  return ref.id;
}

/**
 * Rename and/or replace the stage list. A stage is deleted by leaving it
 * out; refused while any deal still sits in it, so a save can never strand
 * a deal on a stage that no longer renders.
 */
export async function updatePipeline(opts: {
  subAccountId: string;
  pipeline: PipelineDoc;
  name?: string;
  stages?: PipelineStage[];
  actor?: AgentActor;
}): Promise<{ ok: true } | PipelineRefusal> {
  const { subAccountId, pipeline } = opts;
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (opts.name !== undefined) update.name = opts.name;
  if (opts.stages !== undefined) {
    const keep = new Set(opts.stages.map((s) => s.id));
    for (const old of pipeline.stages) {
      if (keep.has(old.id)) continue;
      const count = await countDeals(subAccountId, pipeline.id, old.id);
      if (count > 0) {
        return {
          ok: false,
          status: 409,
          error: `"${old.label}" still has ${count} deal${count === 1 ? "" : "s"}. Move them first.`,
          stageId: old.id,
          count,
        };
      }
    }
    update.stages = opts.stages;
  }
  await pipelineRef(subAccountId, pipeline.id).update({ ...update, ...agentEditStamp(opts.actor) });
  return { ok: true };
}

/** Refused for the default pipeline and for any pipeline that still has deals. */
export async function deletePipeline(subAccountId: string, pipeline: PipelineDoc): Promise<{ ok: true } | PipelineRefusal> {
  if (pipeline.isDefault) {
    return { ok: false, status: 409, error: "The default pipeline can't be deleted." };
  }
  const count = await countDeals(subAccountId, pipeline.id);
  if (count > 0) {
    return {
      ok: false,
      status: 409,
      error: `This pipeline still has ${count} deal${count === 1 ? "" : "s"}. Move or delete them first.`,
      count,
    };
  }
  await pipelineRef(subAccountId, pipeline.id).delete();
  return { ok: true };
}

import "server-only";

import { createPipeline } from "@/lib/pipelines/write";
import {
  MAX_STAGES,
  PIPELINE_NAME_MAX,
  STAGE_LABEL_MAX,
  slugifyStageId,
  validatePipelineName,
  validateStages,
  type Validation,
} from "@/lib/pipelines/stages";
import { isDocId } from "@/lib/server/doc-id";
import type { PipelineStage } from "@/types/deals";
import type { GhlPipelineTarget } from "@/lib/import/ghl/transform";

/**
 * GHL pipeline import: recreate each GHL pipeline as a pipeline in this
 * sub-account BEFORE the drain starts, and hand the drain a GHL-id →
 * LeadStack-id map. The pipeline list comes from the wizard's preview, so
 * every id, name and count is checked here; anything that fails is skipped
 * with a warning and its deals take the legacy squash-onto-default path.
 */

/** Bound on pipelines one import request may create. */
export const MAX_IMPORTED_PIPELINES = 25;
/** GHL stages kept per pipeline — Won and Lost are appended. */
const KEPT_STAGES = MAX_STAGES - 2;

export interface RecreatedGhlPipelines {
  pipelineMap: Record<string, GhlPipelineTarget>;
  /** GHL stage id → its landing spot in a recreated pipeline. */
  pipelineStageMap: Record<string, { pipelineId: string; stageId: string }>;
  warnings: string[];
}

/**
 * GHL stage names → a validated stage list with Won/Lost appended (GHL
 * tracks outcomes as status, not stages). `ids[i]` is the stage created for
 * the i-th name; undefined when that name was dropped (blank or over
 * `KEPT_STAGES`).
 */
export function importedStages(
  names: string[],
): Validation<{ stages: PipelineStage[]; ids: (string | undefined)[] }> {
  const used = new Set<string>();
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}_${n}`;
    used.add(id);
    return id;
  };
  const raw: { id: string; label: string; terminal?: "won" | "lost" }[] = [];
  const ids: (string | undefined)[] = [];
  for (const [i, name] of names.entries()) {
    const label = name.trim().slice(0, STAGE_LABEL_MAX).trim();
    if (!label || raw.length >= KEPT_STAGES) {
      ids.push(undefined);
      continue;
    }
    const id = unique(slugifyStageId(label) || `stage_${i + 1}`);
    raw.push({ id, label });
    ids.push(id);
  }
  if (raw.length === 0) raw.push({ id: unique("new"), label: "New" });
  raw.push({ id: unique("won"), label: "Won", terminal: "won" });
  raw.push({ id: unique("lost"), label: "Lost", terminal: "lost" });
  const valid = validateStages(raw);
  return valid.ok ? { ok: true, value: { stages: valid.value, ids } } : valid;
}

export async function recreateGhlPipelines(
  subAccountId: string,
  createdByUid: string,
  ghlPipelines: unknown,
): Promise<RecreatedGhlPipelines> {
  const out: RecreatedGhlPipelines = {
    pipelineMap: {},
    pipelineStageMap: {},
    warnings: [],
  };
  const list = Array.isArray(ghlPipelines) ? ghlPipelines : [];
  if (list.length > MAX_IMPORTED_PIPELINES) {
    out.warnings.push(
      `Only the first ${MAX_IMPORTED_PIPELINES} pipelines were recreated — deals in the rest import onto the default pipeline.`,
    );
  }
  for (const item of list.slice(0, MAX_IMPORTED_PIPELINES)) {
    const p = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const ghlId = p.id;
    const rawName = typeof p.name === "string" ? p.name : "";
    const name = validatePipelineName(rawName.trim().slice(0, PIPELINE_NAME_MAX));
    if (!isDocId(ghlId) || !name.ok || Object.hasOwn(out.pipelineMap, ghlId)) {
      out.warnings.push(
        `A pipeline${rawName ? ` ("${rawName.slice(0, PIPELINE_NAME_MAX)}")` : ""} wasn't recreated (invalid or duplicate) — its deals import onto the default pipeline instead.`,
      );
      continue;
    }
    const ghlStages = (Array.isArray(p.stages) ? p.stages : []).filter(
      (s): s is { id: string; name: string } =>
        typeof s === "object" &&
        s !== null &&
        isDocId((s as Record<string, unknown>).id) &&
        typeof (s as Record<string, unknown>).name === "string",
    );
    const built = importedStages(ghlStages.map((s) => s.name));
    if (!built.ok) {
      out.warnings.push(
        `Pipeline "${name.value}" wasn't recreated (${built.error}) — its deals import onto the default pipeline instead.`,
      );
      continue;
    }
    const { stages, ids } = built.value;
    let id: string | null;
    try {
      id = await createPipeline({ subAccountId, createdByUid, name: name.value, stages });
    } catch (err) {
      console.error(
        `[import/ghl] pipeline create failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      id = null;
    }
    if (!id) {
      out.warnings.push(
        `Pipeline "${name.value}" wasn't recreated (creation failed) — its deals import onto the default pipeline instead.`,
      );
      continue;
    }
    const pipelineId = id;
    out.pipelineMap[ghlId] = {
      id: pipelineId,
      firstId: stages[0].id,
      wonId: stages.find((s) => s.terminal === "won")!.id,
      lostId: stages.find((s) => s.terminal === "lost")!.id,
    };
    ghlStages.forEach((s, i) => {
      if (ids[i]) out.pipelineStageMap[s.id] = { pipelineId, stageId: ids[i] };
    });
    if (ids.some((x) => x === undefined)) {
      out.warnings.push(
        `Pipeline "${name.value}" keeps its first ${KEPT_STAGES} named stages — deals in any other stage land on its first stage.`,
      );
    }
  }
  return out;
}

import {
  DEFAULT_PIPELINE_ID,
  resolvePipelineStages,
  type PipelineDoc,
  type PipelineStage,
  type PipelineStageOverride,
} from "@/types/deals";

/**
 * Pure helpers shared by the pipeline routes, the deals service and the
 * client. No Firestore here — see `server.ts` for the reads/writes.
 */

export const PIPELINE_NAME_MAX = 60;
export const STAGE_LABEL_MAX = 40;
export const MAX_STAGES = 20;

/** Tones cycled for operator-added stages (the canonical six keep theirs). */
const STAGE_TONES = [
  "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
];
const WON_TONE = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
const LOST_TONE = "bg-rose-500/10 text-rose-700 dark:text-rose-300";

export function toneFor(stage: Pick<PipelineStage, "terminal">, index: number): string {
  if (stage.terminal === "won") return WON_TONE;
  if (stage.terminal === "lost") return LOST_TONE;
  return STAGE_TONES[index % STAGE_TONES.length];
}

/** `"Needs Review!"` → `"needs_review"`. Empty when nothing survives. */
export function slugifyStageId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** Which pipeline a deal doc belongs to. Absent = the default pipeline. */
export function dealPipelineId(data: { pipelineId?: unknown }): string {
  return typeof data.pipelineId === "string" && data.pipelineId
    ? data.pipelineId
    : DEFAULT_PIPELINE_ID;
}

export function findStage(
  pipeline: Pick<PipelineDoc, "stages">,
  stageId: string | null | undefined,
): PipelineStage | undefined {
  return pipeline.stages.find((s) => s.id === stageId);
}

/**
 * The stages the default pipeline is seeded with: the canonical six with
 * any legacy `subAccounts/{id}.pipelineStages` label/order overrides applied
 * — byte-identical to what `usePipelineStages()` rendered before pipelines
 * existed, so seeding changes nothing a user can see.
 */
export function seedDefaultStages(
  overrides?: PipelineStageOverride[] | null,
): PipelineStage[] {
  return resolvePipelineStages(overrides).map((s) => ({ ...s }));
}

/** The synthesized default pipeline used before its doc exists. */
export function syntheticDefaultPipeline(
  subAccountId: string,
  overrides?: PipelineStageOverride[] | null,
): PipelineDoc {
  return {
    id: DEFAULT_PIPELINE_ID,
    name: "Default",
    stages: seedDefaultStages(overrides),
    isDefault: true,
    agencyId: "",
    subAccountId,
    createdByUid: "",
    createdAt: null,
    updatedAt: null,
  };
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export function validatePipelineName(raw: unknown): Validation<string> {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length < 1 || name.length > PIPELINE_NAME_MAX) {
    return { ok: false, error: `Pipeline name must be 1–${PIPELINE_NAME_MAX} characters.` };
  }
  return { ok: true, value: name };
}

/**
 * Validate a full stage list as sent by the settings UI. Ids are kept when
 * present (a rename must not change a stored stageId) and generated from
 * the label otherwise. Rejects duplicates, empty labels, and more than one
 * won / lost terminal.
 */
export function validateStages(raw: unknown): Validation<PipelineStage[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "A pipeline needs at least one stage." };
  }
  if (raw.length > MAX_STAGES) {
    return { ok: false, error: `A pipeline can have at most ${MAX_STAGES} stages.` };
  }
  const seen = new Set<string>();
  const out: PipelineStage[] = [];
  let won = 0;
  let lost = 0;
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "Each stage must be an object." };
    }
    const r = item as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (label.length < 1 || label.length > STAGE_LABEL_MAX) {
      return { ok: false, error: `Each stage label must be 1–${STAGE_LABEL_MAX} characters.` };
    }
    const id =
      typeof r.id === "string" && r.id.trim() ? r.id.trim() : slugifyStageId(label);
    if (!/^[a-z0-9_]{1,40}$/.test(id)) {
      return { ok: false, error: `Stage id "${id}" must be a lowercase slug.` };
    }
    if (seen.has(id)) {
      return { ok: false, error: `Duplicate stage "${id}".` };
    }
    seen.add(id);
    const terminal =
      r.terminal === "won" || r.terminal === "lost" ? r.terminal : undefined;
    if (terminal === "won") won += 1;
    if (terminal === "lost") lost += 1;
    const stage: PipelineStage = { id, label, tone: toneFor({ terminal }, i) };
    if (terminal) stage.terminal = terminal;
    out.push(stage);
  }
  if (won > 1 || lost > 1) {
    return { ok: false, error: "A pipeline can have one Won stage and one Lost stage." };
  }
  return { ok: true, value: out };
}

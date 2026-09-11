"use client";

import { usePipelines } from "@/hooks/use-pipeline-stages";

const SELECT_CLASS =
  "border-input bg-background mt-2 h-9 w-full rounded-md border px-2 text-sm";

/**
 * Pipeline (+ optional stage) narrowing for the deal triggers and the
 * `move_stage` step. "Any pipeline" is the unset value — what every
 * workflow saved before pipelines existed means. The stage list follows
 * the chosen pipeline (the default's when "any", since that is where the
 * canonical stage ids live).
 */
export function PipelineTriggerConfig({
  pipelineId,
  stageId,
  withStage,
  stagePlaceholder = "Any stage",
  stageLabel = (label) => `Moved to ${label}`,
  onChange,
}: {
  pipelineId: string | null | undefined;
  stageId?: string | null;
  withStage: boolean;
  stagePlaceholder?: string;
  stageLabel?: (label: string) => string;
  onChange: (next: { pipelineId: string | null; stageId: string | null }) => void;
}) {
  const { pipelines, byId } = usePipelines();
  const stages = byId(pipelineId).stages;
  return (
    <>
      {pipelines.length > 1 && (
        <select
          aria-label="Pipeline"
          value={pipelineId ?? ""}
          onChange={(e) =>
            // A different pipeline has different stage ids — reset the stage.
            onChange({ pipelineId: e.target.value || null, stageId: null })
          }
          className={SELECT_CLASS}
        >
          <option value="">Any pipeline</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {withStage && (
        <select
          aria-label="Stage"
          value={stageId ?? ""}
          onChange={(e) =>
            onChange({ pipelineId: pipelineId ?? null, stageId: e.target.value || null })
          }
          className={SELECT_CLASS}
        >
          <option value="">{stagePlaceholder}</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {stageLabel(s.label)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

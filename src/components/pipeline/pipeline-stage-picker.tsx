"use client";

import { Label } from "@/components/ui/label";
import { usePipelines } from "@/hooks/use-pipeline-stages";

const SELECT_CLASS =
  "flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground";

/**
 * Pipeline + stage selects for the deal dialogs. The pipeline select only
 * renders when the sub-account has more than one pipeline; the stage list
 * always comes from the selected pipeline, and switching pipeline lands the
 * deal on that pipeline's first stage.
 */
export function PipelineStagePicker({
  idPrefix,
  pipelineId,
  stageId,
  onChange,
}: {
  idPrefix: string;
  pipelineId: string;
  stageId: string;
  onChange: (next: { pipelineId: string; stageId: string }) => void;
}) {
  const { pipelines, byId } = usePipelines();
  const pipeline = byId(pipelineId);
  return (
    <>
      {pipelines.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-pipeline`}>Pipeline</Label>
          <select
            id={`${idPrefix}-pipeline`}
            value={pipeline.id}
            onChange={(e) => {
              const next = byId(e.target.value);
              onChange({ pipelineId: next.id, stageId: next.stages[0]?.id ?? "" });
            }}
            className={SELECT_CLASS}
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id} className="bg-background text-foreground">
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-stage`}>Stage</Label>
        <select
          id={`${idPrefix}-stage`}
          value={stageId}
          onChange={(e) =>
            onChange({ pipelineId: pipeline.id, stageId: e.target.value })
          }
          className={SELECT_CLASS}
        >
          {pipeline.stages.map((s) => (
            <option key={s.id} value={s.id} className="bg-background text-foreground">
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

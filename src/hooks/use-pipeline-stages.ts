"use client";

import { useMemo } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { DEFAULT_PIPELINE_ID, type PipelineDoc, type PipelineStage } from "@/types/deals";

/**
 * The active sub-account's pipelines (default first) and a lookup by id.
 * Reads from the already-subscribed context — no extra Firestore read.
 */
export function usePipelines(): {
  pipelines: PipelineDoc[];
  defaultPipeline: PipelineDoc;
  byId: (id: string | null | undefined) => PipelineDoc;
} {
  const { pipelines } = useSubAccount();
  return useMemo(() => {
    const defaultPipeline =
      pipelines.find((p) => p.isDefault) ?? pipelines[0];
    return {
      pipelines,
      defaultPipeline,
      // Absent / unknown id ⇒ the default, matching how the server reads a
      // deal with no `pipelineId`.
      byId: (id) =>
        (id && id !== DEFAULT_PIPELINE_ID
          ? pipelines.find((p) => p.id === id)
          : undefined) ?? defaultPipeline,
    };
  }, [pipelines]);
}

/**
 * The DEFAULT pipeline's stages. Consumers that predate multi-pipeline
 * (reports, broadcasts audience, form stage picker, …) mean "the default
 * pipeline" — its stage ids are the canonical six, so their behaviour is
 * unchanged until an admin edits it.
 */
export function usePipelineStages(): PipelineStage[] {
  return usePipelines().defaultPipeline.stages;
}

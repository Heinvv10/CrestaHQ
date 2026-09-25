import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { loadPipeline } from "@/lib/pipelines/server";
import { validatePipelineName, validateStages } from "@/lib/pipelines/stages";
import { deletePipeline, updatePipeline, type PipelineRefusal } from "@/lib/pipelines/write";
import type { PipelineStage } from "@/types/deals";

/**
 * One pipeline. Sub-account admin only.
 *
 * PATCH  — rename and/or replace the stage list (add / rename / reorder /
 *          delete / mark terminal). A stage is deleted by leaving it out;
 *          that is refused with 409 while any deal still sits in it, so a
 *          save can never strand a deal on a stage that no longer renders.
 * DELETE — remove the pipeline. Refused for the default pipeline and for
 *          any pipeline that still has deals (409 with the count).
 */

function refused({ status, error, stageId, count }: PipelineRefusal) {
  return NextResponse.json(
    { error, ...(stageId !== undefined ? { stageId } : {}), ...(count !== undefined ? { count } : {}) },
    { status },
  );
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; pipelineId: string }> },
) {
  const { id: subAccountId, pipelineId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const pipeline = await loadPipeline(subAccountId, pipelineId);
  if (!pipeline) {
    return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  }

  let name: string | undefined;
  if (b.name !== undefined) {
    const v = validatePipelineName(b.name);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    name = v.value;
  }
  let stages: PipelineStage[] | undefined;
  if (b.stages !== undefined) {
    const v = validateStages(b.stages);
    if (!v.ok) {
      return NextResponse.json({ error: v.error }, { status: 400 });
    }
    stages = v.value;
  }

  const done = await updatePipeline({ subAccountId, pipeline, name, stages });
  if (!done.ok) return refused(done);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; pipelineId: string }> },
) {
  const { id: subAccountId, pipelineId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const pipeline = await loadPipeline(subAccountId, pipelineId);
  if (!pipeline) {
    return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  }
  const done = await deletePipeline(subAccountId, pipeline);
  if (!done.ok) return refused(done);
  return NextResponse.json({ ok: true });
}

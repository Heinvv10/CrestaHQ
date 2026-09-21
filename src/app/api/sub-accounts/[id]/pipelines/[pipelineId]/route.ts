import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { countDeals, loadPipeline } from "@/lib/pipelines/server";
import { validatePipelineName, validateStages } from "@/lib/pipelines/stages";

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

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (b.name !== undefined) {
    const name = validatePipelineName(b.name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    update.name = name.value;
  }
  if (b.stages !== undefined) {
    const stages = validateStages(b.stages);
    if (!stages.ok) {
      return NextResponse.json({ error: stages.error }, { status: 400 });
    }
    const keep = new Set(stages.value.map((s) => s.id));
    for (const old of pipeline.stages) {
      if (keep.has(old.id)) continue;
      const count = await countDeals(subAccountId, pipeline.id, old.id);
      if (count > 0) {
        return NextResponse.json(
          {
            error: `"${old.label}" still has ${count} deal${count === 1 ? "" : "s"}. Move them first.`,
            stageId: old.id,
            count,
          },
          { status: 409 },
        );
      }
    }
    update.stages = stages.value;
  }

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}/pipelines/${pipeline.id}`)
    .update(update);
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
  if (pipeline.isDefault) {
    return NextResponse.json(
      { error: "The default pipeline can't be deleted." },
      { status: 409 },
    );
  }
  const count = await countDeals(subAccountId, pipeline.id);
  if (count > 0) {
    return NextResponse.json(
      {
        error: `This pipeline still has ${count} deal${count === 1 ? "" : "s"}. Move or delete them first.`,
        count,
      },
      { status: 409 },
    );
  }
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}/pipelines/${pipeline.id}`)
    .delete();
  return NextResponse.json({ ok: true });
}

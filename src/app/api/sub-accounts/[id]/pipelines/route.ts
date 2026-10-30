import "server-only";

import { NextResponse } from "next/server";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { listPipelines } from "@/lib/pipelines/server";
import { validatePipelineName, validateStages } from "@/lib/pipelines/stages";
import { createPipeline } from "@/lib/pipelines/write";

/**
 * Pipelines per sub-account (`subAccounts/{id}/pipelines`).
 *
 * GET  — list, default first. Member-readable. Creates the default pipeline
 *        on first call (lazy seed from the legacy stage overrides).
 * POST — create a pipeline with its stages. Sub-account admin only.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const pipelines = await listPipelines(subAccountId);
  return NextResponse.json({ ok: true, pipelines });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const name = validatePipelineName(b.name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
  const stages = validateStages(b.stages);
  if (!stages.ok) return NextResponse.json({ error: stages.error }, { status: 400 });

  const id = await createPipeline({
    subAccountId,
    createdByUid: access.uid,
    name: name.value,
    stages: stages.value,
  });
  if (!id) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

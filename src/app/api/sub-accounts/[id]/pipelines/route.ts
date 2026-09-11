import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { listPipelines } from "@/lib/pipelines/server";
import { validatePipelineName, validateStages } from "@/lib/pipelines/stages";
import type { PipelineDoc } from "@/types/deals";

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

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const agencyId = subSnap.data()?.agencyId as string | undefined;
  if (!subSnap.exists || !agencyId) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }

  const ref = db.collection(`subAccounts/${subAccountId}/pipelines`).doc();
  const doc: Omit<PipelineDoc, "id"> = {
    name: name.value,
    stages: stages.value,
    isDefault: false,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return NextResponse.json({ ok: true, id: ref.id }, { status: 201 });
}

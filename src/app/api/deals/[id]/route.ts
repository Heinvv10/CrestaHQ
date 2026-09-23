import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  loadEffectiveTerritoryScope,
  territoryGate,
} from "@/lib/auth/territory-filter";
import {
  DealStageError,
  deleteDealServerSide,
  updateDealServerSide,
  type UpdateDealPatch,
} from "@/lib/server/deals-service";
import { isAssignableMember, parseAssignedToUid } from "@/lib/server/assignee";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { loadPipeline } from "@/lib/pipelines/server";
import { refInSubAccount } from "@/lib/server/tenant-ref";
import { dealPipelineId, findStage } from "@/lib/pipelines/stages";
import { DEAL_PRIORITIES } from "@/types/deals";
import type { DealPriority } from "@/types/deals";

/**
 * Dashboard-facing single-deal routes:
 *   PATCH  /api/deals/:id   — edit fields and/or move stage (emits
 *                             deal.updated + deal.stage.changed/won/lost)
 *   DELETE /api/deals/:id   — delete (emits deal.deleted)
 *
 * Replaces the browser's direct Firestore writes (the edit dialog +
 * Kanban drag) so the matching webhooks fire from the shared service.
 */

const VALID_PRIORITIES = new Set(DEAL_PRIORITIES.map((p) => p.id));

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`deals/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }
  const data = snap.data()!;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, data.territoryId as string | null);
  if (gate) return gate;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: UpdateDealPatch = {};
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200);
  if (typeof body.value === "number" && Number.isFinite(body.value) && body.value >= 0) {
    patch.value = body.value;
  }
  if (typeof body.currency === "string" && body.currency.length === 3) {
    patch.currency = body.currency.toUpperCase();
  }
  if (VALID_PRIORITIES.has(body.priority as DealPriority)) {
    patch.priority = body.priority as DealPriority;
  }
  if (typeof body.contactId === "string" && body.contactId.trim()) {
    patch.contactId = body.contactId.trim();
    if (
      patch.contactId !== data.contactId &&
      !(await refInSubAccount("contacts", patch.contactId, data.subAccountId as string))
    ) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
  }
  if (body.territoryId === null || typeof body.territoryId === "string") {
    patch.territoryId =
      typeof body.territoryId === "string" ? body.territoryId : null;
  }
  // A territory-scoped collaborator may not re-home a deal (its territory
  // or its contact) — the rules' territoryIdUnchangedOrAdmin, and what the
  // edit dialog already withholds from them.
  const moves =
    (patch.territoryId !== undefined &&
      patch.territoryId !== ((data.territoryId as string | null) ?? null)) ||
    (patch.contactId !== undefined && patch.contactId !== data.contactId);
  if (moves && (await loadEffectiveTerritoryScope(access)).enforce) {
    return NextResponse.json(
      { error: "Only admins can move a deal to another contact or territory." },
      { status: 403 },
    );
  }
  // A pipeline move must name the landing stage; a stage move is checked
  // against the deal's own pipeline (absent = default).
  if (body.pipelineId !== undefined) {
    if (typeof body.pipelineId !== "string" || !body.pipelineId) {
      return NextResponse.json({ error: "Invalid pipelineId" }, { status: 400 });
    }
    if (typeof body.stageId !== "string") {
      return NextResponse.json(
        { error: "stageId is required when changing pipelineId" },
        { status: 400 },
      );
    }
    patch.pipelineId = body.pipelineId;
  }
  if (body.stageId !== undefined) {
    const pipeline = await loadPipeline(
      data.subAccountId as string,
      patch.pipelineId ?? dealPipelineId(data),
    );
    if (!pipeline) {
      return NextResponse.json({ error: "Invalid pipelineId" }, { status: 400 });
    }
    if (typeof body.stageId !== "string" || !findStage(pipeline, body.stageId)) {
      return NextResponse.json({ error: "Invalid stageId" }, { status: 400 });
    }
    patch.stageId = body.stageId;
  }
  if (body.lostReason === null || typeof body.lostReason === "string") {
    patch.lostReason =
      typeof body.lostReason === "string" ? body.lostReason : null;
  }
  if (typeof body.completed === "boolean") patch.completed = body.completed;
  // Validate only a CHANGED assignee: the edit dialog echoes the stored uid,
  // and a member removed since must not lock every other field's edit.
  const assignedToUid = parseAssignedToUid(body);
  if (
    typeof assignedToUid === "string" &&
    assignedToUid !== ((data.assignedToUid as string | null) ?? null) &&
    !(await isAssignableMember(data.subAccountId as string, assignedToUid))
  ) {
    return NextResponse.json(
      { error: "assignedToUid is not a member of this sub-account" },
      { status: 400 },
    );
  }
  if (assignedToUid !== undefined) patch.assignedToUid = assignedToUid;
  if (body.customFields !== undefined) {
    const defs = await loadCustomFieldDefs(data.subAccountId as string, "deal");
    const cf = validateCustomFieldValues(body.customFields, defs);
    if (!cf.ok) {
      return NextResponse.json({ error: cf.error }, { status: 400 });
    }
    patch.customFields = cf.value;
  }

  let result;
  try {
    result = await updateDealServerSide({
      dealId: id,
      patch,
      userId: access.uid,
      mode: (data.mode as "live" | "test") ?? "live",
      source: "app",
    });
  } catch (err) {
    if (err instanceof DealStageError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  if (!result) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }

  // Auto Google review request when a Won deal is FIRST marked completed.
  // Fire-and-forget; the dispatcher re-checks the sub-account's review config
  // (enabled + triggerOnDealCompleted + cooldown) before sending anything.
  const becameCompleted = patch.completed === true && data.completed !== true;
  if (becameCompleted && result.stageTerminal === "won") {
    void maybeSendReviewRequest({
      subAccountId: data.subAccountId as string,
      agencyId: data.agencyId as string,
      contactId: (result.deal.contact_id ?? data.contactId) as string,
      trigger: "deal_completed",
    });
  }

  return NextResponse.json({ deal: result.deal });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`deals/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }
  const data = snap.data()!;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, data.territoryId as string | null);
  if (gate) return gate;

  await deleteDealServerSide({
    dealId: id,
    mode: (data.mode as "live" | "test") ?? "live",
  });
  return NextResponse.json({ id, object: "deal", deleted: true });
}

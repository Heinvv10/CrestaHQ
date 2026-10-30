import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitDealEvents } from "@/lib/server/deals-service";
import { appendStageEntry } from "@/lib/server/deal-stage-history";
import {
  parseDealPatch,
  serializeDealForApi,
} from "@/lib/api/serializers/deals";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { loadPipeline } from "@/lib/pipelines/server";
import { dealPipelineId, findStage } from "@/lib/pipelines/stages";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * Public API v1: single-deal routes.
 *
 *   GET    /api/v1/deals/:id     — fetch
 *   PATCH  /api/v1/deals/:id     — partial update
 *   DELETE /api/v1/deals/:id     — delete
 *
 * Stage-change semantics: PATCHing `stage` updates `stageChangedAt` to
 * server-now AND emits `deal.stage.changed`. Terminal-state transitions
 * (the pipeline's won / lost stages) ALSO emit `deal.won` / `deal.lost` so
 * subscribers can subscribe to those specifically without filtering
 * server-side. `stage` is validated against the deal's own pipeline.
 */

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const snap = await getAdminDb().doc(`deals/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  const data = snap.data()!;
  if (data.subAccountId !== ctx.subAccountId || data.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  return apiOk(ctx, { deal: serializeDealForApi(snap.id, data, ctx.mode) });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const parsed = parseDealPatch(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
  }
  const patch = parsed.value!;

  const db = getAdminDb();
  const ref = db.doc(`deals/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }

  const writePatch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (patch.title !== undefined) writePatch.title = patch.title;
  if (patch.value !== undefined) writePatch.value = patch.value;
  if (patch.currency !== undefined) writePatch.currency = patch.currency;
  if (patch.priority !== undefined) writePatch.priority = patch.priority;
  if (patch.lostReason !== undefined) writePatch.lostReason = patch.lostReason;
  if (patch.territoryId !== undefined) writePatch.territoryId = patch.territoryId;

  if ((body as Record<string, unknown>).custom_fields !== undefined) {
    const cfDefs = await loadCustomFieldDefs(
      existing.subAccountId as string,
      "deal",
    );
    const cf = validateCustomFieldValues(
      (body as Record<string, unknown>).custom_fields,
      cfDefs,
    );
    if (!cf.ok) {
      return apiError(ctx, "invalid_request", "invalid_body", cf.error!);
    }
    writePatch.customFields = cf.value;
  }

  // Tenancy, the stage's pipeline and the won/lost decision are all judged
  // against the deal as read INSIDE the transaction, and the history row
  // commits with the write. The read above only served the early 404 and
  // the custom-field defs.
  const outcome = await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    if (
      !data ||
      data.subAccountId !== ctx.subAccountId ||
      data.mode !== ctx.mode
    ) {
      return { kind: "not_found" as const };
    }
    let terminal: "won" | "lost" | undefined;
    let write = writePatch;
    if (patch.stage !== undefined) {
      const pipeline = await loadPipeline(
        data.subAccountId as string,
        dealPipelineId(data),
      );
      const stage = pipeline ? findStage(pipeline, patch.stage) : undefined;
      if (!stage) {
        return {
          kind: "invalid_stage" as const,
          stages: (pipeline?.stages ?? []).map((s) => s.id),
        };
      }
      terminal = stage.terminal;
      write = { ...write, stageId: patch.stage };
    }
    const moved = patch.stage !== undefined && patch.stage !== data.stageId;
    if (moved) {
      write = { ...write, stageChangedAt: FieldValue.serverTimestamp() };
    }
    tx.set(ref, write, { merge: true });
    if (moved) {
      appendStageEntry(db, tx, {
        dealId: ref.id,
        deal: { ...data, ...write },
        previous: data,
        byUid: `apikey:${ctx.keyPrefix}`,
        source: "api",
      });
    }
    return { kind: "ok" as const, current: data, terminal };
  });
  if (outcome.kind === "not_found") {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  if (outcome.kind === "invalid_stage") {
    return apiError(
      ctx,
      "invalid_request",
      "invalid_body",
      `\`stage\` must be one of: ${outcome.stages.join(", ")}.`,
    );
  }
  const { current, terminal } = outcome;
  const previousStage = current.stageId as string | undefined;
  const stageChanged = patch.stage !== undefined && patch.stage !== previousStage;

  const fresh = await ref.get();
  const wire = serializeDealForApi(fresh.id, fresh.data()!, ctx.mode);

  // Always emit deal.updated. Stage changes also emit deal.stage.changed +
  // terminal-specific events so subscribers can filter cheaply.
  const events: { type: WebhookEventType; extra?: Record<string, unknown> }[] =
    [{ type: "deal.updated" }];
  if (stageChanged) {
    events.push({
      type: "deal.stage.changed",
      extra: { previous_stage: previousStage ?? null },
    });
    if (terminal === "won") events.push({ type: "deal.won" });
    else if (terminal === "lost") events.push({ type: "deal.lost" });
  }
  emitDealEvents({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    deal: wire,
    events,
    actorUid: `apikey:${ctx.keyPrefix}`,
  });

  return apiOk(ctx, { deal: wire });
});

export const DELETE = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const ref = getAdminDb().doc(`deals/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  await ref.delete();
  emitDealEvents({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    deal: serializeDealForApi(snap.id, existing, ctx.mode),
    events: [{ type: "deal.deleted" }],
    actorUid: `apikey:${ctx.keyPrefix}`,
  });
  return apiOk(ctx, { id: params.id, object: "deal", deleted: true });
});

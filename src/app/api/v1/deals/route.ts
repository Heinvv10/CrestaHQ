import "server-only";

import { FieldPath, FieldValue, type Query } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { isDocId } from "@/lib/server/doc-id";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitDealEvents } from "@/lib/server/deals-service";
import { appendStageEntry } from "@/lib/server/deal-stage-history";
import {
  parseDealCreate,
  serializeDealForApi,
} from "@/lib/api/serializers/deals";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { loadPipeline } from "@/lib/pipelines/server";
import { findStage } from "@/lib/pipelines/stages";
import { isAssignableMember } from "@/lib/server/assignee";
import { GLOBAL_TERRITORY_ID } from "@/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Public API v1: Deals collection routes.
 *
 *   GET  /api/v1/deals                     — list (cursor pagination + filters)
 *        ?limit=20&starting_after=<id>&stage=qualified&contact_id=<id>
 *   POST /api/v1/deals                     — create
 *
 * Filter behaviour:
 *   - `stage` — exact pipeline-stage id
 *   - `contact_id` — deals attached to a specific contact
 *
 * Create accepts `pipeline_id` (absent = the default pipeline); `stage`
 * must be a stage of that pipeline. `assigned_to_uid` (optional, create
 * only) must be an ACTIVE member of the key's sub-account.
 *
 * Both filters are AND-ed. Cursor pagination orders by `stageChangedAt`
 * desc (matches the dashboard's Kanban "most recently moved first"), then
 * doc id desc to tiebreak deals sharing a `stageChangedAt`.
 */

export const GET = withApiAuth(async ({ request, ctx }) => {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;
  const startingAfter = url.searchParams.get("starting_after");
  const stage = url.searchParams.get("stage");
  const contactId = url.searchParams.get("contact_id");

  const db = getAdminDb();
  let q: Query = db
    .collection("deals")
    .where("subAccountId", "==", ctx.subAccountId)
    .where("mode", "==", ctx.mode);

  if (stage) q = q.where("stageId", "==", stage);
  if (contactId) q = q.where("contactId", "==", contactId);
  q = q
    .orderBy("stageChangedAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");

  if (startingAfter) {
    if (!isDocId(startingAfter)) {
      return apiError(ctx, "invalid_request", "invalid_cursor", "starting_after is not a valid id.");
    }
    const cursorSnap = await db.doc(`deals/${startingAfter}`).get();
    if (!cursorSnap.exists) {
      return apiError(
        ctx,
        "invalid_request",
        "invalid_cursor",
        `starting_after=${startingAfter} not found.`,
      );
    }
    const cursor = cursorSnap.data()!;
    if (cursor.subAccountId !== ctx.subAccountId || cursor.mode !== ctx.mode) {
      return apiError(
        ctx,
        "invalid_request",
        "invalid_cursor",
        "Cursor belongs to a different sub-account or mode.",
      );
    }
    // Doc id tiebreaks docs sharing a stageChangedAt (bulk import writes
    // many deals in one batch with a single serverTimestamp).
    q = q.startAfter(cursor.stageChangedAt, startingAfter);
  }

  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  const hasMore = snap.docs.length > limit;
  const data = docs.map((d) =>
    serializeDealForApi(d.id, d.data(), ctx.mode),
  );

  return apiOk(ctx, {
    object: "list",
    data,
    has_more: hasMore,
    url: "/v1/deals",
  });
});

export const POST = withApiAuth(async ({ body, ctx }) => {
  const parsed = parseDealCreate(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", parsed.code ?? "invalid_body", parsed.error!);
  }
  const input = parsed.value!;

  const db = getAdminDb();

  // Verify the referenced contact exists in the same tenancy + mode.
  const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
  if (!contactSnap.exists) {
    return apiError(
      ctx,
      "invalid_request",
      "contact_not_found",
      `contact_id=${input.contactId} does not exist.`,
    );
  }
  const contactData = contactSnap.data()!;
  if (
    contactData.subAccountId !== ctx.subAccountId ||
    contactData.mode !== ctx.mode
  ) {
    return apiError(
      ctx,
      "invalid_request",
      "contact_not_found",
      `contact_id=${input.contactId} does not exist.`,
    );
  }

  const pipeline = await loadPipeline(ctx.subAccountId, input.pipelineId);
  if (!pipeline) {
    return apiError(
      ctx,
      "invalid_request",
      "invalid_body",
      `pipeline_id=${input.pipelineId} does not exist.`,
    );
  }
  if (!findStage(pipeline, input.stage)) {
    return apiError(
      ctx,
      "invalid_request",
      "invalid_body",
      `\`stage\` must be one of: ${pipeline.stages.map((s) => s.id).join(", ")}.`,
    );
  }

  // parseDealCreate already refused a uid that isn't a doc id (invalid_id).
  if (
    input.assignedToUid !== null &&
    !(await isAssignableMember(ctx.subAccountId, input.assignedToUid))
  ) {
    return apiError(
      ctx,
      "invalid_request",
      "invalid_body",
      `assigned_to_uid=${input.assignedToUid} is not an active member of this sub-account.`,
    );
  }

  // Validate any custom_fields against the sub-account's deal definitions.
  const cfDefs = await loadCustomFieldDefs(ctx.subAccountId, "deal");
  const cf = validateCustomFieldValues(
    (body as Record<string, unknown>).custom_fields,
    cfDefs,
  );
  if (!cf.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", cf.error!);
  }

  const ref = db.collection("deals").doc();
  const now = new Date();
  const doc = {
    title: input.title,
    value: input.value,
    currency: input.currency,
    contactId: input.contactId,
    stageId: input.stage,
    pipelineId: pipeline.id,
    priority: input.priority,
    lostReason: null,
    customFields: cf.value,
    territoryId:
      input.territoryId ?? contactData.territoryId ?? GLOBAL_TERRITORY_ID,
    assignedToUid: input.assignedToUid,
    agencyId: ctx.agencyId,
    subAccountId: ctx.subAccountId,
    createdByUid: `apikey:${ctx.keyPrefix}`,
    mode: ctx.mode,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    stageChangedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.set(ref, doc);
  appendStageEntry(db, batch, {
    dealId: ref.id,
    deal: doc,
    previous: null,
    byUid: doc.createdByUid,
    source: "api",
  });
  await batch.commit();

  const created = await ref.get();
  const wire = serializeDealForApi(created.id, created.data()!, ctx.mode);
  if (wire.created_at === new Date(0).toISOString()) {
    wire.created_at = now.toISOString();
    wire.updated_at = now.toISOString();
    wire.stage_changed_at = now.toISOString();
  }

  // The contact summary is enriched from a fresh read inside emitDealEvents;
  // contactData was already validated above so the lookup will resolve.
  emitDealEvents({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    deal: wire,
    events: [{ type: "deal.created" }],
    actorUid: `apikey:${ctx.keyPrefix}`,
  });

  return apiOk(ctx, { deal: wire }, { status: 201 });
});

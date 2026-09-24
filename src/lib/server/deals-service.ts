import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger, type TriggerOutcome } from "@/lib/workflows/engine";
import type { AgentActor, HeldEnrolment } from "@/lib/workflows/agent-hold";
import {
  serializeDealForApi,
  type DealApiObject,
} from "@/lib/api/serializers/deals";
import {
  getStage,
  type DealPriority,
  type PipelineStage,
  type PipelineStageId,
} from "@/types/deals";
import { loadPipeline } from "@/lib/pipelines/server";
import { dealPipelineId, findStage } from "@/lib/pipelines/stages";
import type { WebhookEventType } from "@/types/webhooks";
import type { CustomFieldValue } from "@/types/custom-fields";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { appendStageEntry, type StageMoveSource } from "./deal-stage-history";

/**
 * Server-side Deal write service — the single chokepoint where a deal is
 * created/moved/updated/deleted AND the matching webhook fires. Mirrors
 * `contacts-service.ts`; see that file's header for the why.
 *
 * Stage semantics match `PATCH /api/v1/deals/:id`: every write emits
 * `deal.updated`; a stage change additionally emits `deal.stage.changed`
 * plus the terminal-specific `deal.won` / `deal.lost`, and logs a
 * `pipeline_moved` activity on the contact's timeline.
 *
 * Won / lost are decided by the stage's `terminal` flag on the deal's
 * pipeline (absent `pipelineId` = the default pipeline), never by the
 * literal ids — a custom pipeline names its closed stages whatever it likes.
 * The same points also fire the `deal.created` / `deal.won` / `deal.lost`
 * workflow triggers.
 */

type Mode = "live" | "test";

/**
 * A stage / pipeline the deal's pipeline does not have. Thrown by the write
 * service so no caller — route, AI Suite, quotes lifecycle — can park a deal
 * on a stage id that does not exist in its pipeline. Routes map it to 400.
 */
export class DealStageError extends Error {
  readonly code: "invalid_pipeline" | "invalid_stage" | "no_terminal_stage";
  constructor(code: DealStageError["code"], message: string) {
    super(message);
    this.name = "DealStageError";
    this.code = code;
  }
}

function resolveStage(
  pipeline: { id: string; stages: PipelineStage[] } | null,
  pipelineId: string,
  want: { stageId?: string; terminal?: "won" | "lost" },
): PipelineStage {
  if (!pipeline) {
    throw new DealStageError("invalid_pipeline", `Pipeline "${pipelineId}" not found.`);
  }
  if (want.terminal) {
    const stage = pipeline.stages.find((s) => s.terminal === want.terminal);
    if (!stage) {
      throw new DealStageError(
        "no_terminal_stage",
        `Pipeline "${pipeline.id}" has no ${want.terminal} stage.`,
      );
    }
    return stage;
  }
  const stage = findStage(pipeline, want.stageId);
  if (!stage) {
    throw new DealStageError(
      "invalid_stage",
      `Stage "${want.stageId}" is not on pipeline "${pipeline.id}" (${pipeline.stages.map((s) => s.id).join(", ")}).`,
    );
  }
  return stage;
}

/**
 * The contact fields embedded inline in every deal webhook payload, so
 * subscribers get the email/phone/name without a follow-up lookup. `null`
 * on the payload when the deal has no contact or it couldn't be read.
 */
export interface DealContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

function cleanStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function summaryFromContactData(
  contactId: string,
  data: FirebaseFirestore.DocumentData,
): DealContactSummary {
  return {
    id: contactId,
    name: cleanStr(data.name),
    email: cleanStr(data.email),
    phone: cleanStr(data.phone),
  };
}

/**
 * Look up a deal's contact for the inline webhook summary. Returns null when
 * the deal has no contact or the contact can't be read.
 */
export async function fetchDealContactSummary(
  contactId: string | null | undefined,
): Promise<DealContactSummary | null> {
  if (!contactId) return null;
  try {
    const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
    if (!snap.exists) return null;
    return summaryFromContactData(contactId, snap.data()!);
  } catch {
    return null;
  }
}

/**
 * Fire one or more deal webhook events, enriching each payload with the
 * deal's contact summary (`contact: { id, name, email, phone } | null`).
 * Fire-and-forget: the contact is resolved ONCE and reused across every
 * event in this operation. Pass `contact` to skip the lookup (e.g. the
 * contact was already read, or has been deleted in a cascade).
 *
 * This is the single chokepoint for deal webhook emission — both the
 * dashboard service functions below and the public `/api/v1/deals` routes
 * call it, so every deal event carries the same enriched shape.
 */
export function emitDealEvents(opts: {
  subAccountId: string;
  agencyId: string;
  mode: Mode;
  deal: DealApiObject;
  events: { type: WebhookEventType; extra?: Record<string, unknown> }[];
  contact?: DealContactSummary | null;
}): void {
  void (async () => {
    try {
      const contact =
        opts.contact !== undefined
          ? opts.contact
          : await fetchDealContactSummary(opts.deal.contact_id);
      for (const e of opts.events) {
        await emitWebhookEvent({
          subAccountId: opts.subAccountId,
          agencyId: opts.agencyId,
          mode: opts.mode,
          type: e.type,
          payload: { deal: opts.deal, contact, ...(e.extra ?? {}) },
        });
      }
    } catch (err) {
      console.warn("[deals-service] emitDealEvents failed", err);
    }
  })();
}

/** Write a `pipeline_moved` activity to the contact's timeline (Admin SDK). */
async function writePipelineActivity(
  contactId: string,
  payload: {
    content: string;
    createdBy: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type: "pipeline_moved",
      content: payload.content,
      createdBy: payload.createdBy,
      meta: payload.meta,
      createdAt: FieldValue.serverTimestamp(),
    });
}

export interface CreateDealInput {
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  mode: Mode;
  /** Entry point, stamped on the stage-history row. */
  source: StageMoveSource;
  title: string;
  value: number;
  currency: string;
  contactId: string;
  stageId: PipelineStageId;
  /** Absent = the default pipeline. Always written to the doc. */
  pipelineId?: string;
  priority: DealPriority;
  territoryId?: string | null;
  assignedToUid?: string | null;
  customFields?: Record<string, CustomFieldValue> | null;
  /** An API agent made this write: enrolments are held and awaited. */
  actor?: AgentActor;
}

export interface DealWriteResult {
  id: string;
  deal: DealApiObject;
  /** The stage the deal now sits in, from its pipeline. */
  stage: PipelineStage;
  /** Terminal flag of the stage the deal now sits in (update only). */
  stageTerminal?: "won" | "lost";
  /** Agent writes only: the enrolments held for approval. */
  held?: HeldEnrolment[];
}

/** Create a deal + log the create activity + emit `deal.created`. */
export async function createDealServerSide(
  input: CreateDealInput,
): Promise<DealWriteResult> {
  const db = getAdminDb();
  const ref = db.collection("deals").doc();
  const pipelineId = dealPipelineId(input);
  const pipeline = await loadPipeline(input.subAccountId, pipelineId);
  const stage = resolveStage(pipeline, pipelineId, { stageId: input.stageId });
  const stages = pipeline!.stages;

  const doc = {
    title: input.title,
    value: input.value,
    currency: input.currency,
    contactId: input.contactId,
    stageId: input.stageId,
    pipelineId,
    priority: input.priority,
    lostReason: null,
    customFields: input.customFields ?? {},
    territoryId: input.territoryId ?? GLOBAL_TERRITORY_ID,
    assignedToUid: input.assignedToUid ?? null,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    mode: input.mode,
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
    byUid: input.createdByUid,
    source: input.source,
  });
  await batch.commit();

  await writePipelineActivity(input.contactId, {
    content: `Deal "${input.title}" created in ${getStage(input.stageId, stages).label}`,
    createdBy: input.createdByUid,
    meta: { dealId: ref.id, toStageId: input.stageId, pipelineId },
  });

  const now = new Date();
  const deal = serializeDealForApi(
    ref.id,
    { ...doc, createdAt: now, updatedAt: now, stageChangedAt: now },
    input.mode,
  );

  emitDealEvents({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    deal,
    events: [{ type: "deal.created" }],
  });
  const held = await heldFrom([
    fireDealTrigger({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      mode: input.mode,
      type: "deal.created",
      contactId: input.contactId,
      context: { dealId: ref.id, pipelineId, toStage: input.stageId },
      actor: input.actor,
    }),
  ]);

  return { id: ref.id, deal, stage, ...(input.actor ? { held } : {}) };
}

/**
 * Fire a deal-scoped workflow trigger. Live mode only (test-mode API keys
 * must never enrol real contacts), and only when the deal has a contact —
 * workflow runs are contact-scoped. Fire-and-forget (returns null) unless an
 * API agent made the write: then its enrolments are held and the caller
 * awaits the outcome for them.
 */
function fireDealTrigger(opts: {
  subAccountId: string;
  agencyId: string;
  mode: Mode;
  type: "deal.created" | "deal.won" | "deal.lost" | "pipeline.stage.changed";
  contactId: string | null | undefined;
  context: Record<string, unknown>;
  actor?: AgentActor;
}): Promise<TriggerOutcome> | null {
  if (opts.mode !== "live" || !opts.contactId) return null;
  const fired = fireWorkflowTrigger({
    subAccountId: opts.subAccountId,
    agencyId: opts.agencyId,
    type: opts.type,
    contactId: opts.contactId,
    context: opts.context,
    ...(opts.actor ? { hold: opts.actor } : {}),
  });
  if (!opts.actor) {
    void fired;
    return null;
  }
  return fired;
}

/** The held enrolments of the triggers an agent write awaited. */
async function heldFrom(
  fired: Array<Promise<TriggerOutcome> | null>
): Promise<HeldEnrolment[]> {
  const outcomes = await Promise.all(fired.filter((f) => f !== null));
  return outcomes.flatMap((o) => o.held ?? []);
}

/**
 * Patch a deal. Handles plain field edits, contact re-home, and stage moves
 * in one call (the edit dialog sends all of them together; the Kanban drag
 * sends just `stageId` + optional `lostReason`).
 *
 * `userId` is stamped as the author of the move activity. Returns null when
 * the deal doesn't exist.
 */
export interface UpdateDealPatch {
  title?: string;
  value?: number;
  currency?: string;
  priority?: DealPriority;
  contactId?: string;
  territoryId?: string | null;
  /** Must be a stage of the deal's pipeline, else `DealStageError`. */
  stageId?: PipelineStageId;
  /**
   * Move to the pipeline's Won / Lost stage without knowing its id — for
   * callers that only know the outcome (quote accepted ⇒ won). Takes
   * precedence over `stageId` when both are set.
   */
  terminal?: "won" | "lost";
  /**
   * Move the deal to another pipeline. `stageId` (or `terminal`) is required
   * alongside, since stage ids do not carry across pipelines.
   */
  pipelineId?: string;
  /** Only meaningful on a move to the lost stage. */
  lostReason?: string | null;
  /** "Completed" tick on a Won deal card. Stamps/clears `completedAt`. */
  completed?: boolean;
  /** Member uid (validated by the route) or null to unassign. */
  assignedToUid?: string | null;
  /** Full replacement of the custom-field value map (validated by the route). */
  customFields?: Record<string, CustomFieldValue> | null;
}

export async function updateDealServerSide(opts: {
  dealId: string;
  patch: UpdateDealPatch;
  userId: string;
  mode?: Mode;
  /**
   * Tenancy guard: when set, the update is refused (returns null, exactly
   * like a missing doc) unless the loaded deal's `subAccountId` matches.
   * This function otherwise mutates ANY deal by id — callers whose dealId
   * comes from an untrusted source (the AI Suite, request payloads) MUST
   * pass this so a foreign id can't cross tenants.
   */
  expectedSubAccountId?: string;
  /**
   * Set when a workflow step makes the move: how many workflow-made deal
   * moves led here. Carried on the triggers' context so the next run's
   * move_stage can refuse to extend a cycle (see the engine's execMoveStage).
   */
  workflowDepth?: number;
  /** Entry point, stamped on the stage-history row. */
  source: StageMoveSource;
  /** An API agent made this write: enrolments are held and awaited. */
  actor?: AgentActor;
}): Promise<DealWriteResult | null> {
  const db = getAdminDb();
  const ref = db.doc(`deals/${opts.dealId}`);
  // Read + write in one transaction so the history row's fromStageId is the
  // stage the deal actually left, even under concurrent moves.
  const planned = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    if (
      opts.expectedSubAccountId !== undefined &&
      snap.data()?.subAccountId !== opts.expectedSubAccountId
    ) {
      return null;
    }
    const existing = snap.data()!;
    const mode = opts.mode ?? (existing.mode as Mode) ?? "live";
    const previousStage = existing.stageId as PipelineStageId | undefined;
    const { patch } = opts;
    const previousPipelineId = dealPipelineId(existing);
    const pipelineId = patch.pipelineId ?? previousPipelineId;
    const pipeline = await loadPipeline(existing.subAccountId, pipelineId);
    if (!pipeline) {
      throw new DealStageError("invalid_pipeline", `Pipeline "${pipelineId}" not found.`);
    }
    const stages = pipeline.stages;
    const terminalOf = (stageId: string | undefined) =>
      stageId ? findStage(pipeline, stageId)?.terminal : undefined;
    if (patch.pipelineId !== undefined && patch.stageId === undefined && !patch.terminal) {
      throw new DealStageError("invalid_stage", "A pipeline move needs a stageId.");
    }
    const nextStageId =
      patch.stageId !== undefined || patch.terminal
        ? resolveStage(pipeline, pipelineId, patch).id
        : undefined;

    const write: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (patch.title !== undefined) write.title = patch.title;
    if (patch.value !== undefined) write.value = patch.value;
    if (patch.currency !== undefined) write.currency = patch.currency;
    if (patch.priority !== undefined) write.priority = patch.priority;
    if (patch.contactId !== undefined) write.contactId = patch.contactId;
    if (patch.territoryId !== undefined) write.territoryId = patch.territoryId;
    if (patch.assignedToUid !== undefined) write.assignedToUid = patch.assignedToUid;
    if (patch.customFields !== undefined) write.customFields = patch.customFields;
    if (patch.completed !== undefined) {
      write.completed = patch.completed;
      write.completedAt = patch.completed ? FieldValue.serverTimestamp() : null;
    }

    const stageChanged =
      (nextStageId !== undefined && nextStageId !== previousStage) ||
      pipelineId !== previousPipelineId;
    const nextTerminal = stageChanged
      ? terminalOf(nextStageId ?? previousStage)
      : undefined;
    // Always stamp the pipeline so a pre-pipeline deal gains it on first edit.
    write.pipelineId = pipelineId;
    if (nextStageId !== undefined) {
      write.stageId = nextStageId;
      if (stageChanged) {
        write.stageChangedAt = FieldValue.serverTimestamp();
        // Mirror the old client `moveDeal`: set the reason moving INTO lost,
        // clear it moving back OUT of lost.
        if (nextTerminal === "lost") {
          write.lostReason = patch.lostReason?.trim() || null;
        } else if (existing.lostReason) {
          write.lostReason = null;
        }
      }
    }

    tx.set(ref, write, { merge: true });
    if (stageChanged) {
      appendStageEntry(db, tx, {
        dealId: ref.id,
        deal: { ...existing, ...write },
        previous: existing,
        byUid: opts.userId,
        source: opts.source,
      });
    }
    return {
      existing,
      mode,
      previousStage,
      pipelineId,
      pipeline,
      stages,
      terminalOf,
      stageChanged,
      nextStageId,
      nextTerminal,
      write,
    };
  });
  if (!planned) return null;
  const {
    existing,
    mode,
    previousStage,
    pipelineId,
    pipeline,
    stages,
    terminalOf,
    stageChanged,
    nextStageId,
    nextTerminal,
    write,
  } = planned;

  const fresh = await ref.get();
  const data = fresh.data()!;
  const deal = serializeDealForApi(fresh.id, data, mode);

  const toStage = (nextStageId ?? previousStage) as string;
  if (stageChanged && previousStage) {
    const reasonSuffix =
      nextTerminal === "lost" && write.lostReason
        ? ` — ${write.lostReason as string}`
        : "";
    await writePipelineActivity(data.contactId, {
      content: `Deal "${data.title}" moved from ${getStage(previousStage, stages).label} to ${getStage(toStage, stages).label}${reasonSuffix}`,
      createdBy: opts.userId,
      meta: {
        dealId: fresh.id,
        fromStageId: previousStage,
        toStageId: toStage,
        pipelineId,
      },
    });
  }

  // Always emit deal.updated; a stage move layers the finer events on top.
  const events: { type: WebhookEventType; extra?: Record<string, unknown> }[] =
    [{ type: "deal.updated" }];
  if (stageChanged) {
    events.push({
      type: "deal.stage.changed",
      extra: { previous_stage: previousStage ?? null },
    });
    if (nextTerminal === "won") events.push({ type: "deal.won" });
    else if (nextTerminal === "lost") events.push({ type: "deal.lost" });
  }
  emitDealEvents({
    subAccountId: existing.subAccountId,
    agencyId: existing.agencyId,
    mode,
    deal,
    events,
  });

  // Workflow triggers — a stage move enrols the deal's contact (workflow
  // runs are contact-scoped). `pipelineId` + `toStage` let a workflow narrow
  // to one stage of one pipeline; a won/lost landing also fires its own.
  const fired: Array<Promise<TriggerOutcome> | null> = [];
  if (stageChanged) {
    const base = {
      subAccountId: existing.subAccountId as string,
      agencyId: existing.agencyId as string,
      mode,
      contactId: data.contactId as string | undefined,
      context: {
        dealId: fresh.id,
        pipelineId,
        fromStage: previousStage ?? null,
        toStage,
        ...(opts.workflowDepth !== undefined
          ? { workflowDepth: opts.workflowDepth }
          : {}),
      },
      actor: opts.actor,
    };
    fired.push(fireDealTrigger({ ...base, type: "pipeline.stage.changed" }));
    if (nextTerminal === "won") fired.push(fireDealTrigger({ ...base, type: "deal.won" }));
    else if (nextTerminal === "lost") fired.push(fireDealTrigger({ ...base, type: "deal.lost" }));
  }
  const held = await heldFrom(fired);

  return {
    id: fresh.id,
    deal,
    stage: findStage(pipeline, toStage) ?? getStage(toStage, stages),
    stageTerminal: terminalOf(toStage),
    ...(opts.actor ? { held } : {}),
  };
}

/**
 * Delete a deal + emit `deal.deleted` (serialized from the pre-delete
 * snapshot). Returns false when the deal didn't exist.
 */
export async function deleteDealServerSide(opts: {
  dealId: string;
  mode?: Mode;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`deals/${opts.dealId}`);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data()!;
  const mode = opts.mode ?? (data.mode as Mode) ?? "live";
  const deal = serializeDealForApi(snap.id, data, mode);

  await ref.delete();

  emitDealEvents({
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    mode,
    deal,
    events: [{ type: "deal.deleted" }],
  });
  return true;
}

/**
 * Emit `deal.deleted` from a pre-delete snapshot. Used by paths that delete
 * a deal outside `deleteDealServerSide` — the contact-delete cascade (which
 * batch-deletes a contact's deals) and the public API's deal DELETE.
 */
export function emitDealDeleted(opts: {
  subAccountId: string;
  agencyId: string;
  dealId: string;
  data: FirebaseFirestore.DocumentData;
  mode?: Mode;
  /**
   * Pre-read contact doc data. The contact-delete cascade deletes the
   * contact BEFORE this fires, so a fresh lookup would miss it — pass the
   * contact data the route already read. Omit to look the contact up.
   */
  contactData?: FirebaseFirestore.DocumentData | null;
}): void {
  const mode = opts.mode ?? (opts.data.mode as Mode) ?? "live";
  const deal = serializeDealForApi(opts.dealId, opts.data, mode);
  const contactId = opts.data.contactId as string | null | undefined;
  const contact =
    opts.contactData !== undefined
      ? contactId
        ? summaryFromContactData(contactId, opts.contactData ?? {})
        : null
      : undefined;
  emitDealEvents({
    subAccountId: opts.subAccountId,
    agencyId: opts.agencyId,
    mode,
    deal,
    events: [{ type: "deal.deleted" }],
    contact,
  });
}

/**
 * Emit `deal.created` for a deal already written elsewhere (the public form
 * submit creates a deal inline). Self-guarded so it's safe to `void`.
 */
export async function emitDealCreatedById(opts: {
  subAccountId: string;
  agencyId: string;
  dealId: string;
  mode?: Mode;
}): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`deals/${opts.dealId}`).get();
    if (!snap.exists) return;
    const data = snap.data()!;
    const mode = opts.mode ?? (data.mode as Mode) ?? "live";
    const deal = serializeDealForApi(snap.id, data, mode);
    emitDealEvents({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode,
      deal,
      events: [{ type: "deal.created" }],
    });
    fireDealTrigger({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode,
      type: "deal.created",
      contactId: data.contactId as string | undefined,
      context: {
        dealId: snap.id,
        pipelineId: dealPipelineId(data),
        toStage: data.stageId,
      },
    });
  } catch (err) {
    console.warn("[deals-service] emitDealCreatedById failed", err);
  }
}

import "server-only";

import { createHash } from "node:crypto";
import {
  FieldValue,
  type Firestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import type { WorkflowNode } from "@/types/workflows";
import { DEFAULT_AI_AGENT_PROFILE } from "@/types/ai";
import type { SnapshotApplyResult, SnapshotPayload } from "@/types/snapshots";

interface ApplyScope {
  agencyId: string;
  createdByUid: string;
  /**
   * Identifies the payload being applied — the snapshot id, or (for a
   * single-entity template push) the template id. Combined with
   * `targetSubAccountId` and each entity's `sourceId` to derive a stable doc
   * id (see {@link deterministicId}), so re-running the same apply after a
   * partial failure overwrites what succeeded instead of duplicating it.
   * Also the doc id under `subAccounts/{id}/snapshotApplies` that records
   * apply status.
   */
  snapshotId: string;
}

type PendingWrite = [DocumentReference, Record<string, unknown>];

/**
 * Stable id for an applied doc, derived from the target, the snapshot/
 * template being applied, and the entity's own `sourceId` — so re-applying
 * the same payload into the same sub-account always resolves to the same
 * doc id and `set()` overwrites rather than duplicates. Not a secret; just
 * needs to be deterministic and collision-free across entity kinds.
 */
function deterministicId(
  targetSubAccountId: string,
  snapshotId: string,
  entityKind: string,
  sourceId: string,
): string {
  return createHash("sha256")
    .update([targetSubAccountId, snapshotId, entityKind, sourceId].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/** Drop the snapshot-only `sourceId` before persisting the new doc. */
function dropSourceId<T extends { sourceId: string }>(
  item: T,
): Omit<T, "sourceId"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sourceId, ...rest } = item;
  return rest;
}

/** Firestore caps a batch at 500 ops; stay comfortably under. */
const COMMIT_CHUNK = 450;

async function commitInChunks(db: Firestore, writes: PendingWrite[]) {
  for (let i = 0; i < writes.length; i += COMMIT_CHUNK) {
    const batch = db.batch();
    for (const [ref, data] of writes.slice(i, i + COMMIT_CHUNK)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
}

/**
 * The post-submit redirect points at the SOURCE client's site; a lead
 * submitting the target's form must not land there. Exported so the portable
 * scrub applies the same rule before a payload leaves the agency.
 */
export function sanitizeForm<T extends { settings?: unknown }>(form: T): T {
  if (!form.settings || typeof form.settings !== "object") return form;
  return { ...form, settings: { ...form.settings, redirectUrl: "" } };
}

/**
 * whatsapp_template nodes reference a `subAccounts/{id}/whatsappTemplates` doc
 * that a snapshot does NOT carry — so the id would dangle in the target. Null
 * it; draft status means the workflow never runs until the operator fixes it.
 */
export function sanitizeNodes(
  nodes: Record<string, WorkflowNode> | undefined,
): Record<string, WorkflowNode> {
  const out: Record<string, WorkflowNode> = {};
  for (const [id, node] of Object.entries(nodes ?? {})) {
    if (node.type === "whatsapp_template") {
      out[id] = { ...node, config: { ...node.config, templateId: null } };
    } else if (node.type === "move_stage" && node.config.pipelineId) {
      // Pipeline ids are per sub-account; the target has its own set. Leave
      // the stage (default-pipeline ids are shared) and drop the scoping.
      out[id] = { ...node, config: { ...node.config, pipelineId: null } };
    } else if (node.type === "create_task" && node.config.assignedToUid) {
      // A member uid is the source's; one who also sits on the target (say
      // the agency owner) would silently start receiving its tasks.
      out[id] = { ...node, config: { ...node.config, assignedToUid: null } };
    } else if (node.type === "notify" && node.config.recipient !== "account_contact") {
      // A typed address is the SOURCE client's inbox — like the persona's
      // escalationNotifyEmail, carrying it routes one client's leads to
      // another's team. Fall back to the agency owner. (Legacy configs with
      // no `recipient` mean "custom", so they are reset too.)
      out[id] = { ...node, config: { ...node.config, recipient: "owner", to: "" } };
    } else if (node.type === "webhook") {
      // The URL is an endpoint the source client chose; the target's contact
      // data must not be POSTed there. Blank = the engine skips the step.
      out[id] = { ...node, config: { ...node.config, url: "" } };
    } else {
      out[id] = node;
    }
  }
  return out;
}

/**
 * Write the snapshot's persona to the target, but ONLY if the target still has
 * none at commit time. Returns whether the write landed.
 *
 * The five re-blanked fields belong to the SOURCE client and must never reach
 * another tenant: `businessName` is their trading name, `escalationNotifyEmail`
 * is their team's inbox, and the website KB is a scrape of their homepage that
 * the agent would otherwise state as fact about the wrong business. Capture
 * already excludes all five, so blanking again here is belt-and-braces — it
 * means a hand-built or legacy payload cannot smuggle them in either.
 */
async function writePersonaIfAbsent(
  db: Firestore,
  targetSubAccountId: string,
  profile: NonNullable<SnapshotPayload["aiProfile"]>,
  tenancyStamps: Record<string, unknown>,
): Promise<boolean> {
  const ref = db.doc(`subAccounts/${targetSubAccountId}/aiAgent/profile`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existingPrompt = snap.data()?.systemPrompt;
    if (typeof existingPrompt === "string" && existingPrompt.trim()) {
      return false;
    }
    tx.set(ref, {
      ...DEFAULT_AI_AGENT_PROFILE,
      ...profile,
      businessName: "",
      escalationNotifyEmail: null,
      websiteUrl: null,
      websiteKb: null,
      websiteKbFetchedAt: null,
      ...tenancyStamps,
    });
    return true;
  });
}

/**
 * Apply a snapshot's config into a target sub-account. CREATE-OR-OVERWRITE
 * BY DETERMINISTIC ID: every doc's id is derived from
 * (targetSubAccountId, scope.snapshotId, sourceId), never a fresh random
 * one, so re-running the same apply — after a partial failure, or on
 * purpose — overwrites what it wrote before instead of duplicating it. It
 * never touches a doc it didn't itself write on a prior run, so this is
 * still safe against a live sub-account.
 *
 * Order matters for the form→workflow link: forms are written first so we can
 * build an old→new form-id map, then workflows are written with their
 * `trigger.formId` remapped to the imported form (or nulled when the source
 * form isn't part of the snapshot).
 *
 * Two entities need a read before the write, because unlike the others their
 * identity rule isn't "one doc per sourceId":
 *
 *   - Custom fields are keyed by `key`, unique per (subAccount, entity). A key
 *     the target already defines from ANOTHER source is skipped, never
 *     redefined — a second definition for the same key would fight the first
 *     over the same `contact.customFields` slot.
 *   - The AI persona lives at the fixed path `aiAgent/profile`. It is written
 *     only when the target has none, so applying a snapshot can never silently
 *     replace a persona an operator already tuned. That check runs inside a
 *     transaction (see {@link writePersonaIfAbsent}) rather than as a pre-read,
 *     so it holds even if an operator saves a persona mid-apply.
 *
 * Apply status is recorded at `subAccounts/{targetSubAccountId}/
 * snapshotApplies/{scope.snapshotId}` (started → completed | failed) so a
 * caller — or an operator looking at Firestore — can see a partial apply
 * rather than inferring it from missing docs.
 */
export async function applySnapshot(
  db: Firestore,
  payload: SnapshotPayload,
  targetSubAccountId: string,
  scope: ApplyScope,
): Promise<SnapshotApplyResult> {
  const statusRef = db.doc(
    `subAccounts/${targetSubAccountId}/snapshotApplies/${scope.snapshotId}`,
  );
  await statusRef.set(
    { status: "started", startedAt: FieldValue.serverTimestamp(), error: null },
    { merge: true },
  );
  try {
    const result = await writeSnapshot(db, payload, targetSubAccountId, scope);
    await statusRef.set(
      { status: "completed", completedAt: FieldValue.serverTimestamp(), error: null },
      { merge: true },
    );
    return result;
  } catch (err) {
    await statusRef.set(
      {
        status: "failed",
        failedAt: FieldValue.serverTimestamp(),
        error: err instanceof Error ? err.message : "apply failed",
      },
      { merge: true },
    );
    throw err;
  }
}

async function writeSnapshot(
  db: Firestore,
  payload: SnapshotPayload,
  targetSubAccountId: string,
  scope: ApplyScope,
): Promise<SnapshotApplyResult> {
  const { agencyId, createdByUid, snapshotId } = scope;
  const stamp = () => FieldValue.serverTimestamp();
  const tenancy = () => ({
    agencyId,
    subAccountId: targetSubAccountId,
    createdByUid,
    createdAt: stamp(),
    updatedAt: stamp(),
  });
  const detId = (entityKind: string, sourceId: string) =>
    deterministicId(targetSubAccountId, snapshotId, entityKind, sourceId);

  const writes: PendingWrite[] = [];

  // Pre-read for the custom-field dedupe (see above). The persona is NOT
  // pre-read here — its read and write happen inside one transaction below, so
  // the create-only guarantee holds under concurrency rather than by luck.
  const existingFieldsSnap = await db
    .collection(`subAccounts/${targetSubAccountId}/customFields`)
    .get();
  const takenFieldKeys = new Set(
    existingFieldsSnap.docs.map((d) => `${d.data().entity}:${d.data().key}`),
  );

  // 1) Forms first — build old→new id map for the workflow remap.
  const formIdMap = new Map<string, string>();
  for (const form of payload.forms) {
    const ref = db.collection("forms").doc(detId("form", form.sourceId));
    formIdMap.set(form.sourceId, ref.id);
    writes.push([
      ref,
      { ...dropSourceId(sanitizeForm(form)), id: ref.id, ...tenancy(), submissionCount: 0 },
    ]);
  }

  // 2) Self-contained config — copies verbatim with fresh identity.
  for (const template of payload.messageTemplates) {
    const ref = db
      .collection("message_templates")
      .doc(detId("message_template", template.sourceId));
    writes.push([ref, { ...dropSourceId(template), id: ref.id, ...tenancy() }]);
  }
  for (const product of payload.products) {
    const ref = db.collection("products").doc(detId("product", product.sourceId));
    writes.push([ref, { ...dropSourceId(product), id: ref.id, ...tenancy() }]);
  }

  // 3) Workflows — sanitize on apply.
  let workflowsLinked = 0;
  for (const workflow of payload.workflows) {
    const ref = db.collection("workflows").doc(detId("workflow", workflow.sourceId));
    const config = dropSourceId(workflow);

    // Remap the trigger's source form id to the imported form, else null it.
    // A pipeline id names a doc under the SOURCE sub-account — null it like
    // an unmapped form (absent = any pipeline; the operator re-pins it).
    const trigger = { ...config.trigger };
    if (trigger.pipelineId) trigger.pipelineId = null;
    // A booking page slug is scoped to the SOURCE sub-account too — null it
    // like an unmapped pipeline; the operator re-pins it to a page under
    // the target sub-account.
    if (trigger.bookingPageSlug) trigger.bookingPageSlug = null;
    if (trigger.formId) {
      const mapped = formIdMap.get(trigger.formId);
      if (mapped) {
        trigger.formId = mapped;
        workflowsLinked += 1;
      } else {
        trigger.formId = null;
      }
    }

    writes.push([
      ref,
      {
        ...config,
        id: ref.id,
        ...tenancy(),
        // Never enroll contacts until the operator reviews + activates.
        status: "draft",
        trigger,
        nodes: sanitizeNodes(config.nodes),
        stats: { enrolled: 0, completed: 0 },
      },
    ]);
  }

  // 4) Custom-field definitions — skip any key the target already defines.
  let customFieldsCreated = 0;
  let customFieldsSkipped = 0;
  for (const field of payload.customFields ?? []) {
    if (takenFieldKeys.has(`${field.entity}:${field.key}`)) {
      customFieldsSkipped += 1;
      continue;
    }
    const ref = db
      .collection(`subAccounts/${targetSubAccountId}/customFields`)
      .doc(detId("custom_field", field.sourceId));
    writes.push([ref, { ...dropSourceId(field), id: ref.id, ...tenancy() }]);
    customFieldsCreated += 1;
  }

  await commitInChunks(db, writes);

  // 5) AI persona — transactional, because it is the one write that targets a
  // FIXED path rather than a fresh id. Reading existence up front and writing
  // in a later batch leaves a window in which an operator saves a persona for
  // the target and this call silently overwrites it. Re-reading inside the
  // transaction closes it: the write only lands if the target still has no
  // persona at commit time.
  const aiProfileApplied = payload.aiProfile
    ? await writePersonaIfAbsent(db, targetSubAccountId, payload.aiProfile, tenancy())
    : false;

  return {
    formsCreated: payload.forms.length,
    templatesCreated: payload.messageTemplates.length,
    productsCreated: payload.products.length,
    workflowsCreated: payload.workflows.length,
    workflowsLinked,
    customFieldsCreated,
    customFieldsSkipped,
    aiProfileApplied,
  };
}

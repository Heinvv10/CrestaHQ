import "server-only";

import {
  FieldValue,
  type Firestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import type { WorkflowNode } from "@/types/workflows";
import type { SnapshotApplyResult, SnapshotPayload } from "@/types/snapshots";
import { customFieldKeyId, deterministicId, writePersonaIfAbsent } from "./apply-target";

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

/** gRPC ALREADY_EXISTS: create() on a doc that is already there. */
const ALREADY_EXISTS = 6;

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
/** `getAll` has no hard cap like `in`'s 30, but stay comfortably bounded. */
const GET_ALL_CHUNK = 300;

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
 * Which of `refs` already exist in the target, keyed by path. A prior apply
 * of this same snapshot writes at these exact (deterministic) ids, so this
 * is how a retry tells "I already wrote this" from "this is new" — see
 * {@link writeSnapshot}, which never overwrites a doc this returns.
 */
export async function existingPaths(
  db: Firestore,
  refs: DocumentReference[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < refs.length; i += GET_ALL_CHUNK) {
    const snaps = await db.getAll(...refs.slice(i, i + GET_ALL_CHUNK));
    for (const s of snaps) if (s.exists) found.add(s.ref.path);
  }
  return found;
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
 * Apply a snapshot's config into a target sub-account. CREATE-ONLY BY
 * DETERMINISTIC ID: every doc's id is derived from
 * (targetSubAccountId, scope.snapshotId, sourceId) instead of a fresh
 * random one, so a retry — after a partial failure, or applying the same
 * snapshot again on purpose — recognises what it already wrote and never
 * touches it again. A doc that already exists at that id is counted as
 * skipped, not re-created, and its fields are left exactly as an operator
 * may have since edited them (an activated workflow stays active, edited
 * nodes stay edited). It still never touches a doc it didn't itself write,
 * so this is safe against a live sub-account either way.
 *
 * Order matters for the form→workflow link: forms are written first so we can
 * build an old→new form-id map, then workflows are written with their
 * `trigger.formId` remapped to the imported form (or nulled when the source
 * form isn't part of the snapshot). The map is populated even for a form
 * that already existed (skipped, not written this run) — the workflow still
 * needs to link to it.
 *
 * Two entities need a read before the write, because unlike the others their
 * identity rule isn't "one doc per sourceId":
 *
 *   - Custom fields are keyed by `key`, unique per (subAccount, entity). A key
 *     the target already defines — by this same snapshot on a prior apply, or
 *     by any other source — is skipped, never redefined; a second definition
 *     for the same key would fight the first over the same
 *     `contact.customFields` slot.
 *   - The AI persona lives at the fixed path `aiAgent/profile`. It is written
 *     only when the target has none, so applying a snapshot can never silently
 *     replace a persona an operator already tuned. That check runs inside a
 *     transaction (see {@link writePersonaIfAbsent}) rather than as a pre-read,
 *     so it holds even if an operator saves a persona mid-apply.
 *
 * Apply status is recorded at `subAccounts/{targetSubAccountId}/
 * snapshotApplies/{scope.snapshotId}` (started → completed | failed) so a
 * caller — or an operator looking at Firestore — can see a partial apply
 * rather than inferring it from missing docs. It's a forensic record only,
 * not read by any route; a failure to write it must never hide or replace
 * the real error from the apply itself.
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
  await recordStatus(statusRef, {
    status: "started",
    startedAt: FieldValue.serverTimestamp(),
    error: null,
  });
  try {
    const result = await writeSnapshot(db, payload, targetSubAccountId, scope);
    await recordStatus(statusRef, {
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      error: null,
    });
    return result;
  } catch (err) {
    await recordStatus(statusRef, {
      status: "failed",
      failedAt: FieldValue.serverTimestamp(),
      error: err instanceof Error ? err.message : "apply failed",
    });
    throw err;
  }
}

/**
 * Best-effort — this is a forensic record, not part of the apply's
 * correctness. A failure writing it is logged and swallowed so it can never
 * mask (or replace) the real error the caller above is already handling.
 */
async function recordStatus(
  ref: DocumentReference,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    await ref.set(patch, { merge: true });
  } catch (err) {
    console.error("[snapshots/apply] failed to record apply status", err);
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

  // Resolve every form/template/product/workflow ref up front (ids alone,
  // no reads) so a single batched existence check tells us which ones a
  // PRIOR apply already wrote — those are never touched again, see the
  // doc comment above.
  const formRefs = payload.forms.map((f) => db.collection("forms").doc(detId("form", f.sourceId)));
  const templateRefs = payload.messageTemplates.map((t) =>
    db.collection("message_templates").doc(detId("message_template", t.sourceId)),
  );
  const productRefs = payload.products.map((p) =>
    db.collection("products").doc(detId("product", p.sourceId)),
  );
  const workflowRefs = payload.workflows.map((w) =>
    db.collection("workflows").doc(detId("workflow", w.sourceId)),
  );
  const alreadyWritten = await existingPaths(db, [
    ...formRefs,
    ...templateRefs,
    ...productRefs,
    ...workflowRefs,
  ]);

  // 1) Forms first — build old→new id map for the workflow remap. The map
  // gets an entry even for a form this run skips (already written by a
  // prior apply) — a workflow still needs to link to it.
  const formIdMap = new Map<string, string>();
  let formsCreated = 0;
  let formsSkipped = 0;
  payload.forms.forEach((form, i) => {
    const ref = formRefs[i];
    formIdMap.set(form.sourceId, ref.id);
    if (alreadyWritten.has(ref.path)) {
      formsSkipped += 1;
      return;
    }
    writes.push([
      ref,
      { ...dropSourceId(sanitizeForm(form)), id: ref.id, ...tenancy(), submissionCount: 0 },
    ]);
    formsCreated += 1;
  });

  // 2) Self-contained config — copies verbatim with fresh identity.
  let templatesCreated = 0;
  let templatesSkipped = 0;
  payload.messageTemplates.forEach((template, i) => {
    const ref = templateRefs[i];
    if (alreadyWritten.has(ref.path)) {
      templatesSkipped += 1;
      return;
    }
    writes.push([ref, { ...dropSourceId(template), id: ref.id, ...tenancy() }]);
    templatesCreated += 1;
  });
  let productsCreated = 0;
  let productsSkipped = 0;
  payload.products.forEach((product, i) => {
    const ref = productRefs[i];
    if (alreadyWritten.has(ref.path)) {
      productsSkipped += 1;
      return;
    }
    writes.push([ref, { ...dropSourceId(product), id: ref.id, ...tenancy() }]);
    productsCreated += 1;
  });

  // 3) Workflows — sanitize on apply.
  let workflowsLinked = 0;
  let workflowsCreated = 0;
  let workflowsSkipped = 0;
  payload.workflows.forEach((workflow, i) => {
    const ref = workflowRefs[i];
    if (alreadyWritten.has(ref.path)) {
      // Already applied — an operator may since have activated it and
      // edited its nodes. Leave it alone; do not re-link or re-draft it.
      workflowsSkipped += 1;
      return;
    }
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
    workflowsCreated += 1;
  });

  await commitInChunks(db, writes);

  // 4) Custom-field definitions — skip any key the target already defines
  // (by this snapshot on a prior apply, or by any other source). The doc id
  // is the KEY's, target-wide (customFieldKeyId), written with create(): of
  // two applies racing past the read above, or one payload naming a key
  // twice, exactly one defines it and the other counts it as skipped.
  let customFieldsCreated = 0;
  let customFieldsSkipped = 0;
  for (const field of payload.customFields ?? []) {
    if (takenFieldKeys.has(`${field.entity}:${field.key}`)) {
      customFieldsSkipped += 1;
      continue;
    }
    const ref = db
      .collection(`subAccounts/${targetSubAccountId}/customFields`)
      .doc(customFieldKeyId(targetSubAccountId, field.entity, field.key));
    try {
      await ref.create({ ...dropSourceId(field), id: ref.id, ...tenancy() });
      customFieldsCreated += 1;
    } catch (err) {
      if ((err as { code?: unknown })?.code !== ALREADY_EXISTS) throw err;
      customFieldsSkipped += 1;
    }
  }

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
    formsCreated,
    formsSkipped,
    templatesCreated,
    templatesSkipped,
    productsCreated,
    productsSkipped,
    workflowsCreated,
    workflowsSkipped,
    workflowsLinked,
    customFieldsCreated,
    customFieldsSkipped,
    aiProfileApplied,
  };
}

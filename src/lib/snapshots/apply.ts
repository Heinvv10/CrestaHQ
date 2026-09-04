import "server-only";

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
}

type PendingWrite = [DocumentReference, Record<string, unknown>];

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
 * whatsapp_template nodes reference a `subAccounts/{id}/whatsappTemplates` doc
 * that a snapshot does NOT carry — so the id would dangle in the target. Null
 * it; draft status means the workflow never runs until the operator fixes it.
 */
function sanitizeNodes(
  nodes: Record<string, WorkflowNode> | undefined,
): Record<string, WorkflowNode> {
  const out: Record<string, WorkflowNode> = {};
  for (const [id, node] of Object.entries(nodes ?? {})) {
    if (node.type === "whatsapp_template") {
      out[id] = { ...node, config: { ...node.config, templateId: null } };
    } else {
      out[id] = node;
    }
  }
  return out;
}

/**
 * Apply a snapshot's config into a target sub-account. CREATE-ONLY: every doc
 * is written with a fresh id and never overwrites/updates/deletes anything
 * already in the target, so this is safe to run against a live sub-account.
 *
 * Order matters for the form→workflow link: forms are created first so we can
 * build an old→new form-id map, then workflows are created with their
 * `trigger.formId` remapped to the imported form (or nulled when the source
 * form isn't part of the snapshot).
 *
 * Two entities need a read before the write to honour create-only, because
 * unlike the others they are not addressed by a fresh auto-id:
 *
 *   - Custom fields are keyed by `key`, unique per (subAccount, entity). A key
 *     the target already defines is skipped, never redefined — a second
 *     definition for the same key would fight the first over the same
 *     `contact.customFields` slot.
 *   - The AI persona lives at the fixed path `aiAgent/profile`. It is written
 *     only when the target has none, so applying a snapshot can never silently
 *     replace a persona an operator already tuned.
 */
export async function applySnapshot(
  db: Firestore,
  payload: SnapshotPayload,
  targetSubAccountId: string,
  scope: ApplyScope,
): Promise<SnapshotApplyResult> {
  const { agencyId, createdByUid } = scope;
  const stamp = () => FieldValue.serverTimestamp();
  const tenancy = () => ({
    agencyId,
    subAccountId: targetSubAccountId,
    createdByUid,
    createdAt: stamp(),
    updatedAt: stamp(),
  });

  const writes: PendingWrite[] = [];

  // Pre-reads for the two create-only-by-content entities (see above).
  const [existingFieldsSnap, existingProfileSnap] = await Promise.all([
    db.collection(`subAccounts/${targetSubAccountId}/customFields`).get(),
    db.doc(`subAccounts/${targetSubAccountId}/aiAgent/profile`).get(),
  ]);
  const takenFieldKeys = new Set(
    existingFieldsSnap.docs.map((d) => `${d.data().entity}:${d.data().key}`),
  );

  // 1) Forms first — build old→new id map for the workflow remap.
  const formIdMap = new Map<string, string>();
  for (const form of payload.forms) {
    const ref = db.collection("forms").doc();
    formIdMap.set(form.sourceId, ref.id);
    writes.push([
      ref,
      { ...dropSourceId(form), id: ref.id, ...tenancy(), submissionCount: 0 },
    ]);
  }

  // 2) Self-contained config — copies verbatim with fresh identity.
  for (const template of payload.messageTemplates) {
    const ref = db.collection("message_templates").doc();
    writes.push([ref, { ...dropSourceId(template), id: ref.id, ...tenancy() }]);
  }
  for (const product of payload.products) {
    const ref = db.collection("products").doc();
    writes.push([ref, { ...dropSourceId(product), id: ref.id, ...tenancy() }]);
  }

  // 3) Workflows — sanitize on apply.
  let workflowsLinked = 0;
  for (const workflow of payload.workflows) {
    const ref = db.collection("workflows").doc();
    const config = dropSourceId(workflow);

    // Remap the trigger's source form id to the imported form, else null it.
    const trigger = { ...config.trigger };
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
      .doc();
    writes.push([ref, { ...dropSourceId(field), id: ref.id, ...tenancy() }]);
    customFieldsCreated += 1;
  }

  // 5) AI persona — only when the snapshot carries one and the target has none.
  const existingPrompt = existingProfileSnap.data()?.systemPrompt;
  const targetHasPersona =
    typeof existingPrompt === "string" && existingPrompt.trim().length > 0;
  const aiProfileApplied = Boolean(payload.aiProfile) && !targetHasPersona;
  if (aiProfileApplied && payload.aiProfile) {
    writes.push([
      db.doc(`subAccounts/${targetSubAccountId}/aiAgent/profile`),
      {
        ...DEFAULT_AI_AGENT_PROFILE,
        ...payload.aiProfile,
        // Re-blanked per SnapshotAiProfile: these belong to the source client
        // and must be filled in for the target before the agent goes live.
        businessName: "",
        escalationNotifyEmail: null,
        websiteUrl: null,
        websiteKb: null,
        websiteKbFetchedAt: null,
        createdAt: stamp(),
        updatedAt: stamp(),
      },
    ]);
  }

  await commitInChunks(db, writes);

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

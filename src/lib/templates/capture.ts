import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { stripDoc } from "@/lib/snapshots/capture";
import type {
  SnapshotForm,
  SnapshotMessageTemplate,
  SnapshotPayload,
  SnapshotWorkflow,
} from "@/types/snapshots";
import type { AgencyTemplateKind } from "@/types/templates";

/**
 * Thrown when the entity cannot be captured for the caller. Every case is a
 * 404 on purpose: "exists but belongs to another tenant" must be
 * indistinguishable from "does not exist", or the route leaks which ids are
 * live in other agencies.
 */
export class TemplateCaptureError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "TemplateCaptureError";
  }
}

export interface CaptureScope {
  agencyId: string;
  subAccountId: string;
}

export interface CapturedEntity {
  payload: SnapshotPayload;
  /** The entity's own name — the default library name. */
  entityName: string;
  /** True when a form-triggered workflow brought its trigger form along. */
  includesTriggerForm: boolean;
}

const COLLECTION: Record<AgencyTemplateKind, string> = {
  workflow: "workflows",
  email: "message_templates",
  form: "forms",
};

const emptyPayload = (): SnapshotPayload => ({
  forms: [],
  messageTemplates: [],
  products: [],
  workflows: [],
});

/**
 * Read one doc and refuse unless it sits in the scope's sub-account. The
 * sub-account itself is checked against the agency first, so a doc id from
 * another agency's tenant can never be reached by naming a sub-account the
 * caller does not own.
 */
async function readScoped(
  db: Firestore,
  scope: CaptureScope,
  path: string,
  label: string,
): Promise<{ id: string; data: FirebaseFirestore.DocumentData }> {
  const snap = await db.doc(path).get();
  const data = snap.data();
  if (!snap.exists || !data || data.subAccountId !== scope.subAccountId) {
    throw new TemplateCaptureError(`${label} not found in this sub-account.`);
  }
  return { id: snap.id, data };
}

/**
 * Capture ONE workflow / email template / form from a sub-account into a
 * snapshot-shaped payload. Same stripping as a full snapshot ({@link stripDoc})
 * so `applySnapshot` handles the push with no template-specific branch.
 *
 * A workflow whose trigger is a form also carries that form (when it is in
 * the same sub-account): apply builds its old→new form-id map from
 * `payload.forms`, so without it the pushed workflow's trigger would be
 * nulled and the operator would have to re-pin it by hand.
 */
export async function captureEntity(
  db: Firestore,
  scope: CaptureScope,
  kind: AgencyTemplateKind,
  entityId: string,
): Promise<CapturedEntity> {
  const subSnap = await db.doc(`subAccounts/${scope.subAccountId}`).get();
  if (!subSnap.exists || subSnap.data()?.agencyId !== scope.agencyId) {
    throw new TemplateCaptureError("Sub-account not found in this agency.");
  }

  const payload = emptyPayload();
  const { id, data } = await readScoped(
    db,
    scope,
    `${COLLECTION[kind]}/${entityId}`,
    kind === "workflow" ? "Workflow" : kind === "email" ? "Email template" : "Form",
  );
  const entityName = typeof data.name === "string" ? data.name : "";

  if (kind === "form") {
    payload.forms.push(
      stripDoc(id, data, ["submissionCount"]) as unknown as SnapshotForm,
    );
    return { payload, entityName, includesTriggerForm: false };
  }

  if (kind === "email") {
    // SMS templates are out of scope for the library; the list UI only
    // offers the button on email rows, and this is the server-side half.
    if (data.type !== "email") {
      throw new TemplateCaptureError("Email template not found in this sub-account.");
    }
    payload.messageTemplates.push(
      stripDoc(id, data) as unknown as SnapshotMessageTemplate,
    );
    return { payload, entityName, includesTriggerForm: false };
  }

  payload.workflows.push(
    stripDoc(id, data, ["stats", "folderId"]) as unknown as SnapshotWorkflow,
  );
  const formId = data.trigger?.formId;
  let includesTriggerForm = false;
  if (typeof formId === "string" && formId) {
    const formSnap = await db.doc(`forms/${formId}`).get();
    const form = formSnap.data();
    // A trigger pointing at a form outside this sub-account is already a
    // dangling reference; apply nulls it, same as a full snapshot would.
    if (formSnap.exists && form && form.subAccountId === scope.subAccountId) {
      payload.forms.push(
        stripDoc(formSnap.id, form, ["submissionCount"]) as unknown as SnapshotForm,
      );
      includesTriggerForm = true;
    }
  }
  return { payload, entityName, includesTriggerForm };
}

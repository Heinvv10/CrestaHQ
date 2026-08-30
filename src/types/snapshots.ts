import type { Timestamp, FieldValue } from "firebase/firestore";
import type { LeadForm } from "./forms";
import type { Product } from "./products";
import type { MessageTemplateDoc } from "./automations";
import type { WorkflowDoc } from "./workflows";

/**
 * Snapshots — GoHighLevel-style reusable config templates.
 *
 * A snapshot captures the CONFIG of one sub-account (forms, message
 * templates, products, workflows) into a single agency-scoped document, so
 * an agency owner can stamp a proven setup onto another sub-account in one
 * click. It deliberately carries NO customer data (contacts, deals,
 * submissions, runs) and NO credentials.
 *
 * Storage: `agencies/{agencyId}/snapshots/{snapshotId}`. Agency-owner read;
 * all writes go through the Admin-SDK routes (capture + apply) which own the
 * strip-on-capture and sanitize-on-apply logic.
 *
 * v1 is agency-internal and config-light. The doc carries a `version` so a
 * future schema change can be migrated on apply rather than breaking old
 * snapshots.
 */

export const SNAPSHOT_VERSION = 1 as const;

/**
 * Tenancy + identity + audit fields stamped per-tenant. Stripped at capture
 * time and re-stamped fresh at apply time, so they never travel inside a
 * snapshot.
 */
type TenancyStamps =
  | "id"
  | "agencyId"
  | "subAccountId"
  | "createdByUid"
  | "createdAt"
  | "updatedAt";

/**
 * Every captured entity keeps its ORIGINAL source doc id. Forms need it so
 * apply can build an old→new form-id map; workflows reference their source
 * form via `trigger.formId`, which apply remaps through that map.
 */
type Captured<T> = { sourceId: string } & T;

/** A form minus tenancy + its runtime submission counter. */
export type SnapshotForm = Captured<
  Omit<LeadForm, TenancyStamps | "submissionCount">
>;

/** A message template minus tenancy. Fully self-contained. */
export type SnapshotMessageTemplate = Captured<
  Omit<MessageTemplateDoc, TenancyStamps>
>;

/** A product minus tenancy. Fully self-contained. */
export type SnapshotProduct = Captured<Omit<Product, TenancyStamps>>;

/**
 * A workflow minus tenancy + runtime stats. The node graph (startNodeId /
 * next / branches) is internal to the doc and copies verbatim — no
 * remapping. `trigger.formId` still holds the SOURCE form id here; apply
 * remaps it to the new form (or nulls it when the form isn't in the
 * snapshot).
 */
export type SnapshotWorkflow = Captured<
  Omit<WorkflowDoc, TenancyStamps | "stats">
>;

export interface SnapshotPayload {
  forms: SnapshotForm[];
  messageTemplates: SnapshotMessageTemplate[];
  products: SnapshotProduct[];
  workflows: SnapshotWorkflow[];
}

export interface SnapshotDoc {
  id: string;
  agencyId: string;
  name: string;
  description: string;
  version: typeof SNAPSHOT_VERSION;
  /** The sub-account this snapshot was captured from (provenance only). */
  sourceSubAccountId: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  payload: SnapshotPayload;
}

/** Returned by applySnapshot + the apply API route. */
export interface SnapshotApplyResult {
  formsCreated: number;
  templatesCreated: number;
  productsCreated: number;
  workflowsCreated: number;
  /** Workflows whose `trigger.formId` was successfully remapped to an
   *  imported form (vs nulled because the source form wasn't in the
   *  snapshot). */
  workflowsLinked: number;
}

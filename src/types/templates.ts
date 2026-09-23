import type { Timestamp, FieldValue } from "firebase/firestore";
import type { SNAPSHOT_VERSION, SnapshotPayload } from "./snapshots";

/**
 * Template library — GoHighLevel "Template Library" parity, scoped to one
 * entity at a time. Where a snapshot copies a whole sub-account's config, a
 * library template carries ONE workflow, email template or form so the
 * agency owner can push a single proven asset into any sub-account.
 *
 * Storage: `agencies/{agencyId}/templates/{templateId}`. Agency-owner read;
 * all writes go through the Admin-SDK routes. The payload is a
 * {@link SnapshotPayload} holding only that entity, so push reuses
 * `applySnapshot` unchanged — create-only, workflows land as drafts, the
 * trigger form is remapped when it travels alongside.
 */

export type AgencyTemplateKind = "workflow" | "email" | "form";

export const AGENCY_TEMPLATE_KINDS: readonly AgencyTemplateKind[] = [
  "workflow",
  "email",
  "form",
];

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_DESCRIPTION_MAX = 300;
export const TEMPLATE_TAGS_MAX = 10;
export const TEMPLATE_TAG_MAX = 30;
export const TEMPLATE_PUSH_TARGETS_MAX = 50;

export interface AgencyTemplateDoc {
  id: string;
  agencyId: string;
  createdByUid: string;
  kind: AgencyTemplateKind;
  name: string;
  description: string;
  tags: string[];
  /** The sub-account the entity was captured from (provenance only). */
  sourceSubAccountId: string;
  /**
   * Exactly one entity, plus — for a form-triggered workflow — its trigger
   * form, so apply's formId remap keeps the two linked on the target.
   */
  payload: SnapshotPayload;
  version: typeof SNAPSHOT_VERSION;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** What the list route returns per template — never the payload body. */
export interface AgencyTemplateSummary {
  id: string;
  kind: AgencyTemplateKind;
  name: string;
  description: string;
  tags: string[];
  sourceSubAccountId: string;
  /** True when a workflow template also carries its trigger form. */
  includesTriggerForm: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

/** One entry per target sub-account in a push. */
export interface TemplatePushResult {
  subAccountId: string;
  ok: boolean;
  error?: string;
  created: { forms: number; messageTemplates: number; workflows: number };
  /** Already present from a prior push of this same template — left
   *  untouched, not re-created (see applySnapshot's deterministic ids). */
  skipped: { forms: number; messageTemplates: number; workflows: number };
}

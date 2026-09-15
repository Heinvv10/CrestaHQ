import type { Timestamp, FieldValue } from "firebase/firestore";
import type { LeadForm } from "./forms";
import type { Product } from "./products";
import type { MessageTemplateDoc } from "./automations";
import type { WorkflowDoc } from "./workflows";
import type { AiAgentProfile } from "./ai";
import type { CustomFieldDef } from "./custom-fields";

/**
 * Snapshots — GoHighLevel-style reusable config templates.
 *
 * A snapshot captures the CONFIG of one sub-account (forms, message
 * templates, products, workflows, custom-field definitions and the AI agent
 * persona) into a single agency-scoped document, so
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

/**
 * A custom-field definition minus tenancy. `key` is unique per (subAccount,
 * entity) and is what `contact.customFields` / `deal.customFields` are keyed
 * by, so apply skips any key the target already defines rather than minting a
 * second definition for the same key.
 */
export type SnapshotCustomField = Captured<Omit<CustomFieldDef, TenancyStamps>>;

/**
 * The AI agent persona, minus everything that belongs to the SOURCE client.
 *
 * Three fields are deliberately NOT carried:
 *
 *   - `businessName` — the source client's trading name. Blank on apply so
 *     the prompt falls back to the target sub-account's own name.
 *   - `escalationNotifyEmail` — an inbox belonging to the source client.
 *     Carrying it would route one client's escalations to another's team.
 *   - `websiteUrl` / `websiteKb` / `websiteKbFetchedAt` — a Firecrawl scrape
 *     of the source client's homepage. Factual content about the wrong
 *     business is worse than no KB at all, because the agent states it
 *     confidently.
 *
 * What travels is the reusable part: the persona prompt, operating hours,
 * timezone and escalation keywords. The prompt itself may still name the
 * source business inline — it is a starting point the operator edits, and
 * the apply route leaves the channel toggles off so nothing replies to a
 * customer before that edit happens.
 */
export type SnapshotAiProfile = Pick<
  AiAgentProfile,
  "systemPrompt" | "hoursStart" | "hoursEnd" | "timezone" | "escalationKeywords"
>;

export interface SnapshotPayload {
  forms: SnapshotForm[];
  messageTemplates: SnapshotMessageTemplate[];
  products: SnapshotProduct[];
  workflows: SnapshotWorkflow[];
  /** Absent on v1 snapshots captured before these were added. */
  customFields?: SnapshotCustomField[];
  /** Absent on v1 snapshots, and on sub-accounts with no persona set. */
  aiProfile?: SnapshotAiProfile | null;
}

export interface SnapshotDoc {
  id: string;
  agencyId: string;
  name: string;
  description: string;
  version: typeof SNAPSHOT_VERSION;
  /**
   * The sub-account this snapshot was captured from (provenance only). Null
   * on an imported copy — the source sub-account belongs to another agency.
   */
  sourceSubAccountId: string | null;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  payload: SnapshotPayload;
  /** Set only on a copy imported through another agency's share link. */
  importedFrom?: SnapshotImportedFrom;
}

/**
 * Marks an imported snapshot. Deliberately carries no id of the sharing
 * agency, its snapshot, or the share — only when the copy arrived.
 */
export interface SnapshotImportedFrom {
  importedAt: Timestamp | FieldValue | null;
}

/** Link lifetimes an owner can pick when sharing. */
export const SNAPSHOT_SHARE_EXPIRY_DAYS = [1, 7, 30] as const;
export type SnapshotShareExpiryDays = (typeof SNAPSHOT_SHARE_EXPIRY_DAYS)[number];

/**
 * A share link for one snapshot, at
 * `agencies/{agencyId}/snapshots/{snapshotId}/shares/{shareId}`. Server-only.
 *
 * Only the sha256 of the link's token is stored — the raw token exists in the
 * create response and nowhere else, so a leaked database read cannot be
 * replayed as an import. `snapshotShareIndex/{tokenHash}` maps the hash back
 * to this doc so import needs no collection-group query.
 */
export interface SnapshotShareDoc {
  id: string;
  agencyId: string;
  snapshotId: string;
  snapshotName: string;
  createdByUid: string;
  tokenHash: string;
  expiresAt: Timestamp;
  singleUse: boolean;
  usedCount: number;
  revokedAt: Timestamp | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type SnapshotShareStatus = "active" | "expired" | "revoked" | "used";

/** A share as the owner UI sees it — no token hash, millis timestamps. */
export interface SnapshotShareSummary {
  id: string;
  snapshotId: string;
  snapshotName: string;
  expiresAt: number;
  singleUse: boolean;
  usedCount: number;
  revokedAt: number | null;
  createdAt: number | null;
  status: SnapshotShareStatus;
}

/** Returned by applySnapshot + the apply API route. */
export interface SnapshotApplyResult {
  formsCreated: number;
  templatesCreated: number;
  productsCreated: number;
  workflowsCreated: number;
  customFieldsCreated: number;
  /** Custom fields skipped because the target already defines that key. */
  customFieldsSkipped: number;
  /** True when the persona was written. False when the snapshot carried none,
   *  or the target already had a persona (apply never overwrites one). */
  aiProfileApplied: boolean;
  /** Workflows whose `trigger.formId` was successfully remapped to an
   *  imported form (vs nulled because the source form wasn't in the
   *  snapshot). */
  workflowsLinked: number;
}

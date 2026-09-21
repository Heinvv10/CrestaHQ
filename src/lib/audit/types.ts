/**
 * The `auditEvents` contract: who changed what, on which tenant, from which
 * surface. Full contract and the decisions behind it:
 * docs/architecture/audit-events.md.
 */

/** Every action the stream records. A new call site adds its action here. */
export const AUDIT_ACTIONS = [
  "feature_gates.updated",
  "workflow.status_changed",
  "member.role_changed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The surface a change came from. */
export const AUDIT_ACTOR_TYPES = [
  "user",
  "api_key",
  "workflow",
  "ai_agent",
  "cron",
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * `id` is the uid for a user, the key id (never the secret) for an API key,
 * the workflow id, the AI agent id, or the cron job name.
 */
export interface AuditActor {
  type: AuditActorType;
  id: string;
}

export const AUDIT_TARGET_TYPES = ["subAccount", "workflow", "member"] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export interface AuditTarget {
  type: AuditTargetType;
  id: string;
}

/**
 * What a caller may pass as a before/after value. Strings are kept only when
 * they look like an enum value (see `auditValue`); anything else is stored
 * as REDACTED.
 */
export type AuditInputValue = string | number | boolean | null | undefined;
export type AuditStoredValue = string | number | boolean | null;

export interface AuditChangeInput {
  field: string;
  before: AuditInputValue;
  after: AuditInputValue;
}

export interface AuditEventInput {
  action: AuditAction;
  actor: AuditActor;
  target: AuditTarget;
  agencyId: string;
  /** null for an agency-level event (readable by the agency owner only). */
  subAccountId: string | null;
  changes: AuditChangeInput[];
}

/** The stored doc, minus `createdAt` (a server timestamp). */
export interface AuditEventDoc {
  action: AuditAction;
  actor: AuditActor;
  target: AuditTarget;
  agencyId: string;
  subAccountId: string | null;
  /** The actor's uid when the actor is a user, else null. */
  createdByUid: string | null;
  changes: { field: string; before: AuditStoredValue; after: AuditStoredValue }[];
}

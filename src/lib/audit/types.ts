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
  // Every direct (non-approval) write an API agent made (lib/api/agent-audit).
  "agent.write",
  // A Google review reply posted by the auto-reply engine, no click
  // (lib/reputation/auto-reply/post.ts). Target: the cached review's doc id.
  "review.auto_replied",
  // A usage-rebilling switch flipped: the agency master switch (agency-level
  // event, target "agency") or one client's switch (target "subAccount").
  "usage_rebilling.updated",
  // The agency-level switch that lets an overdue usage charge wall a client
  // workspace (target "agency").
  "usage_paywall.updated",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The surface a change came from. */
export const AUDIT_ACTOR_TYPES = [
  "user",
  "api_key",
  "workflow",
  "ai_agent",
  "cron",
  // Server-side processes with no user behind them: inbound-message hooks,
  // imports. `id` names the process, e.g. "inbound-whatsapp" or "qcontact-import".
  "system",
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * `id` is the uid for a user, the key id (never the secret) for an API key,
 * the workflow id, the AI agent id, the cron job name, or the system process name.
 */
export interface AuditActor {
  type: AuditActorType;
  id: string;
}

export const AUDIT_TARGET_TYPES = [
  "subAccount",
  "workflow",
  "member",
  // Records an agent write can touch (agent.write).
  "contact",
  "deal",
  "task",
  "event",
  "whatsappTemplate",
  // A cached Google review (`gbpReviews/{docId}`) — review.auto_replied.
  "review",
  // An agency snapshot (`agencies/{id}/snapshots/{snapshotId}`) an agent applied (agent.write).
  "snapshot",
  // An agency billing plan (`agencies/{id}/plans/{planId}`) an agent created (agent.write, agency-level).
  "billingPlan",
  // The agency doc itself (`agencies/{id}`) — usage_rebilling.updated, usage_paywall.updated.
  "agency",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export interface AuditTarget {
  type: AuditTargetType;
  id: string;
}

/**
 * What a caller may pass as a before/after value. A value is kept only when
 * its action + field allow-list names it (see `AUDIT_ALLOWED_VALUES`);
 * anything else is stored as REDACTED.
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
  /**
   * The signed-in user a non-user actor acted for — e.g. whoever asked the
   * Workspace Assistant. Stored as `createdByUid`. Ignored for a user actor.
   */
  onBehalfOfUid?: string;
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

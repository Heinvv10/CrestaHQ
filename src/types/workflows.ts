import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Workflow Builder — the general automation engine that replaces the legacy
 * single-recipe `automations` engine. A workflow is a TRIGGER + a graph of
 * NODES (linear with if/else branches). A RUN is one contact's enrollment
 * walking that graph; the QStash step worker advances it node by node.
 */

export type WorkflowStatus = "draft" | "active" | "paused";

/**
 * Re-enrollment policy, enforced at trigger time. "every_time" (the default
 * — absent on every pre-v2 doc) matches the original engine behavior;
 * "unless_active" skips contacts with a run currently running/waiting;
 * "once_ever" enrolls each contact at most once, ever. Test enrollments
 * bypass the policy.
 */
export type WorkflowReentry = "every_time" | "unless_active" | "once_ever";

export type WorkflowTriggerType =
  | "contact.created"
  | "contact.tag.added"
  | "form.submitted"
  | "pipeline.stage.changed"
  | "booking.created"
  | "booking.cancelled"
  | "booking.rescheduled"
  | "quote.accepted"
  | "quote.paid"
  | "message.received"
  // A tracked link was clicked by a KNOWN contact — i.e. the visit carried
  // a per-contact token. A tokenless click has no one to enrol and fires
  // nothing. See lib/tracked-links/click.ts.
  | "link.clicked"
  // Payments v1 — a card payment through the sub-account's OWN Stripe was
  // confirmed by Stripe. Sibling of quote.paid (which covers the manual
  // mark-paid path). Fired from lib/server/orders-service.ts.
  | "order.paid";

/* ------------------------------ Conditions ----------------------------- */

export type ConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "is_set"
  | "not_set"
  | "has_tag"
  | "in_stage"
  | "source_is";

export interface Condition {
  /** Contact field path (e.g. "email", "company", "customFields.x"). */
  field: string;
  op: ConditionOp;
  value?: string;
}

/**
 * A flat condition list. `match` picks the combinator: "all" (AND, the
 * default — absent on every pre-v2 doc) or "any" (OR). Nested groups stay
 * deferred.
 */
export interface ConditionGroup {
  all: Condition[];
  match?: "all" | "any";
}

/* -------------------------------- Trigger ------------------------------ */

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  filters: ConditionGroup;
  /** Restrict `form.submitted` to one form. Null/absent = any form. */
  formId?: string | null;
  /** Restrict `link.clicked` to one tracked link. Null/absent = any link. */
  linkId?: string | null;
  /** Restrict `pipeline.stage.changed` to one target stage. */
  toStage?: string | null;
  /**
   * Restrict `message.received` to one inbox channel
   * (sms | whatsapp | messenger | instagram). Null/absent = any channel.
   */
  channel?: string | null;
}

/* --------------------------------- Nodes ------------------------------- */

export type WorkflowNodeType =
  | "send_email"
  | "send_sms"
  | "whatsapp_template"
  | "send_whatsapp"
  | "wait"
  | "wait_for_reply"
  | "if_else"
  | "goal"
  | "add_tag"
  | "remove_tag"
  | "move_stage"
  | "update_field"
  | "create_task"
  | "notify"
  | "webhook";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Node-type-specific config (validated per type at execution). */
  config: Record<string, unknown>;
  /** Next node for a linear step. Null/absent ends the run. */
  next?: string | null;
  /**
   * Branch targets for a branching node. `if_else`: whenTrue = conditions
   * pass. `wait_for_reply`: whenTrue = the contact replied, whenFalse = the
   * timeout elapsed with no reply.
   */
  branches?: { whenTrue: string | null; whenFalse: string | null };
}

export interface WorkflowDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  name: string;
  status: WorkflowStatus;
  trigger: WorkflowTrigger;
  /** Re-enrollment policy. Absent = "every_time". */
  reentry?: WorkflowReentry;
  /** Entry node id. Null = empty workflow (won't enroll). */
  startNodeId: string | null;
  nodes: Record<string, WorkflowNode>;
  stats: { enrolled: number; completed: number };
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/* --------------------------------- Runs -------------------------------- */

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "exited";

export interface WorkflowRunHistoryEntry {
  nodeId: string;
  type: WorkflowNodeType;
  at: Timestamp | FieldValue | null;
  /**
   * "ok" | "skipped:<reason>" | "error:<msg>" | "branch:true|false" |
   * "replied:<channel>" | "timeout".
   */
  result: string;
}

/**
 * Set while a run is parked on a `wait_for_reply` node. The inbound-message
 * hook resolves it early (Replied branch); the QStash timeout callback
 * resolves it late (No-reply branch). A transaction claims the node so
 * exactly one path wins; the winner appends the node's history entry, which
 * the step worker's idempotency guard then treats as terminal.
 */
export interface WorkflowRunWaiting {
  nodeId: string;
  kind: "reply";
  since: Timestamp | FieldValue | null;
  until: Timestamp | FieldValue | null;
}

export interface WorkflowRunDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  workflowId: string;
  contactId: string;
  status: WorkflowRunStatus;
  currentNodeId: string | null;
  /** Non-null while parked on a `wait_for_reply` node. */
  waiting?: WorkflowRunWaiting | null;
  history: WorkflowRunHistoryEntry[];
  /** Trigger payload snapshot (e.g. { formId, dealId }). */
  context: Record<string, unknown>;
  qstashMessageId: string | null;
  enrolledAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/* ------------------------ Node config (typed views) -------------------- */

export interface SendEmailConfig {
  subject: string;
  body: string;
}
export interface SendSmsConfig {
  body: string;
}
export interface WhatsappTemplateConfig {
  /** Approved WhatsApp template doc id (subAccounts/{id}/whatsappTemplates). */
  templateId: string;
  /**
   * Which of the sub-account's WhatsApp senders this step goes out on
   * (`whatsappSenders[].id`). Empty or absent means the workspace default,
   * which is what every step built before the sender registry carries.
   */
  senderId?: string;
  /**
   * Operator-set values for the template's MANUAL variables, keyed by position
   * (string keys for JSON). May contain merge tags; resolved at run time.
   * `merge_tag` variables auto-resolve from the contact and aren't stored here.
   */
  manualValues?: Record<string, string>;
}
/**
 * Free-form WhatsApp with a template fallback.
 *
 * Distinct from {@link WhatsappTemplateConfig}, which can ONLY send a template.
 * That node bills every send at template rates even when the contact's service
 * window is open and free-form text would cost nothing — the ~$87/mo shape
 * `docs/PARITY_PLAN.md` identified. It is also unusable on the `bridge` rail,
 * which has no template concept at all.
 *
 * This node carries the message itself and defers the send mode to
 * `resolveWaSendMode()` at run time: free-form when that is legal (window open,
 * or a rail with no window), the template only as the fallback that re-opens a
 * closed one. `templateId` is therefore optional — a step that only ever fires
 * inside an open window needs no template, and so needs no Meta approval.
 */
export interface SendWhatsappConfig {
  /** Free-form message body. Merge tags resolved at run time. */
  body: string;
  /**
   * Approved template used ONLY when the window is shut. Empty means the step
   * is skipped in that case rather than sent at template rates.
   */
  templateId?: string;
  /** Manual template variable values, as in {@link WhatsappTemplateConfig}. */
  manualValues?: Record<string, string>;
}
export interface WaitConfig {
  seconds: number;
}
/** Timeout window for a `wait_for_reply` node. */
export interface WaitForReplyConfig {
  seconds: number;
}
export interface IfElseConfig {
  conditions: ConditionGroup;
}
export interface TagConfig {
  tag: string;
}
export interface MoveStageConfig {
  stage: string;
}
export interface UpdateFieldConfig {
  field: string;
  value: string;
}
export interface CreateTaskConfig {
  title: string;
  dueInDays?: number;
}
/** Who an Internal notification step emails. Legacy configs predate this
 *  field — the engine treats a missing value like "custom" (use `to`, else
 *  fall back to the agency owner) for backward compatibility. */
export type NotifyRecipient = "owner" | "account_contact" | "custom";

export interface NotifyConfig {
  /** Recipient mode. Optional so pre-existing stored configs still parse. */
  recipient?: NotifyRecipient;
  /** Literal email — only used when `recipient` is "custom" (or absent). */
  to: string;
  subject: string;
  body: string;
}
export interface WebhookConfig {
  url: string;
}

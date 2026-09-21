import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { AgencyGateField } from "@/lib/server/feature-gates-service";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditEventDoc,
  type AuditEventInput,
  type AuditInputValue,
  type AuditStoredValue,
} from "./types";

export const AUDIT_EVENTS_COLLECTION = "auditEvents";
export const REDACTED = "[redacted]";

/**
 * The only values ever stored, per action and field. A value not listed here —
 * a name, an email, a domain, a number, an unlisted field — is stored as
 * REDACTED. `null`/`undefined` are stored as null: "had no value" is not PII.
 * A field that needs its value audited is added here, deliberately.
 */
const GATE_VALUES = [true, false] as const;
const GATE_FIELDS: Record<AgencyGateField, true> = {
  emailDomainEnabledByAgency: true,
  apiAccessEnabledByAgency: true,
  broadcastsEnabledByAgency: true,
  outboundVoiceEnabledByAgency: true,
  whatsappEnabledByAgency: true,
  smsAgentEnabledByAgency: true,
  webChatEnabledByAgency: true,
  inboundVoiceEnabledByAgency: true,
  metaInboxEnabledByAgency: true,
  metaAgentEnabledByAgency: true,
  websiteEnabledByAgency: true,
  socialPlannerEnabledByAgency: true,
  communityEnabledByAgency: true,
  missedCallTextBackEnabledByAgency: true,
  aiSuiteEnabledByAgency: true,
  labsEnabledByAgency: true,
  reviewsAiEnabledByAgency: true,
  getLeadsEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  webinar1EnabledByAgency: true,
  googleEnabledByAgency: true,
  googleCalendarEnabledByAgency: true,
};

export const AUDIT_ALLOWED_VALUES: Record<
  AuditAction,
  Readonly<Record<string, readonly AuditStoredValue[]>>
> = {
  "feature_gates.updated": Object.fromEntries(
    Object.keys(GATE_FIELDS).map((field) => [field, GATE_VALUES])
  ),
  "workflow.status_changed": { status: ["draft", "active", "paused"] },
  "member.role_changed": { role: ["admin", "collaborator"] },
};

export function auditValue(
  action: AuditAction,
  field: string,
  value: AuditInputValue
): AuditStoredValue {
  if (value === undefined || value === null) return null;
  const allowed = Object.hasOwn(AUDIT_ALLOWED_VALUES[action], field)
    ? AUDIT_ALLOWED_VALUES[action][field]
    : [];
  return allowed.includes(value) ? value : REDACTED;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/**
 * Validates the input and shapes the stored doc. Throws on a malformed
 * event: that is a bug at the call site, and an event with no actor or no
 * tenant is worse than no event, because it looks like an answer.
 */
export function buildAuditEvent(input: AuditEventInput): AuditEventDoc {
  const { actor, target } = input;
  if (!actor || !isOneOf(AUDIT_ACTOR_TYPES, actor.type) || !isNonEmptyString(actor.id)) {
    throw new Error("[audit] event requires an actor with a known type and an id");
  }
  if (!isOneOf(AUDIT_ACTIONS, input.action)) {
    throw new Error(`[audit] unknown action: ${String(input.action)}`);
  }
  if (!target || !isOneOf(AUDIT_TARGET_TYPES, target.type) || !isNonEmptyString(target.id)) {
    throw new Error("[audit] event requires a target with a known type and an id");
  }
  if (!isNonEmptyString(input.agencyId)) {
    throw new Error("[audit] event requires an agencyId");
  }
  if (input.subAccountId !== null && !isNonEmptyString(input.subAccountId)) {
    throw new Error("[audit] subAccountId must be a non-empty string or null");
  }
  if (!Array.isArray(input.changes) || input.changes.some((c) => !isNonEmptyString(c?.field))) {
    throw new Error("[audit] every change needs a field name");
  }

  return {
    action: input.action,
    actor: { type: actor.type, id: actor.id },
    target: { type: target.type, id: target.id },
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: actor.type === "user" ? actor.id : null,
    changes: input.changes.map((c) => ({
      field: c.field,
      before: auditValue(input.action, c.field, c.before),
      after: auditValue(input.action, c.field, c.after),
    })),
  };
}

/**
 * Appends one row to `auditEvents`. Call it AFTER the change it records has
 * committed. A malformed event throws (see buildAuditEvent); a failed write
 * is logged and swallowed, because the change itself already landed and a
 * route that 500s over its audit row reports a failure for a change that in
 * fact happened.
 */
export async function recordAuditEvent(
  db: FirebaseFirestore.Firestore,
  input: AuditEventInput
): Promise<void> {
  const doc = buildAuditEvent(input);
  try {
    await db.collection(AUDIT_EVENTS_COLLECTION).add({
      ...doc,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(
      `[audit] failed to record ${doc.action} on ${doc.target.type}/${doc.target.id}`,
      err
    );
  }
}

/**
 * The call-site entry point for a change to one sub-account. The tenant is
 * read from the sub-account doc as stored — never from the request body or
 * URL — and the actor is whoever the caller authenticated. Nothing here can
 * fail the request: the change has already committed, so even a malformed
 * event is logged rather than thrown (the call site's route test is what
 * catches that).
 */
export async function recordSubAccountAuditEvent(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  event: Omit<AuditEventInput, "agencyId" | "subAccountId">
): Promise<void> {
  try {
    const sub = await db.doc(`subAccounts/${subAccountId}`).get();
    await recordAuditEvent(db, {
      ...event,
      agencyId: sub.data()?.agencyId,
      subAccountId: sub.id,
    });
  } catch (err) {
    console.error(
      `[audit] could not record ${event.action} on ${event.target.type}/${event.target.id}`,
      err
    );
  }
}

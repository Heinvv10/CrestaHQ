import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  AUDIT_TARGET_TYPES,
  type AuditEventDoc,
  type AuditEventInput,
  type AuditInputValue,
  type AuditStoredValue,
} from "./types";

export const AUDIT_EVENTS_COLLECTION = "auditEvents";
export const REDACTED = "[redacted]";

/**
 * Lowercase identifier-shaped strings — "admin", "paused", "sms_enabled".
 * Emails (@), phone numbers (leading digit or +), names (capitals, spaces)
 * and message bodies (spaces) all fail it and are stored as REDACTED.
 */
const ENUM_LIKE = /^[a-z][a-z0-9_.-]{0,63}$/;

export function auditValue(value: AuditInputValue): AuditStoredValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : REDACTED;
  return ENUM_LIKE.test(value) ? value : REDACTED;
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
      before: auditValue(c.before),
      after: auditValue(c.after),
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

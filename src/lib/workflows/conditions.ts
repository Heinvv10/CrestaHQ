import "server-only";

import type { Condition, ConditionGroup } from "@/types/workflows";
import type { Contact } from "@/types/contacts";

/**
 * Extra values a condition can read that do not live on the contact.
 *
 * `replyText` is the message body that resumed a `wait_for_reply` node. It is
 * deliberately NOT stored on the contact: it is per-run, and two runs of the
 * same workflow for one contact can be branching on different answers.
 */
export interface ConditionContext {
  replyText?: string | null;
}

/** The one non-contact field path a condition may reference. */
export const REPLY_TEXT_FIELD = "reply.text";

/**
 * Evaluate a workflow ConditionGroup against a contact. `match: "all"` (the
 * default) requires every condition; `match: "any"` requires at least one.
 * Used for both trigger filters and `if_else` branch nodes. An empty group
 * is always true (no filter).
 *
 * Trigger filters pass no context, so a `reply.text` condition there reads
 * null and cannot pass — a trigger fires before any reply exists, so matching
 * one would be meaningless rather than merely unsupported.
 */
function getField(
  contact: Contact,
  path: string,
  ctx?: ConditionContext,
): unknown {
  if (path === REPLY_TEXT_FIELD) return ctx?.replyText ?? null;
  if (path.startsWith("customFields.")) {
    const key = path.slice("customFields.".length);
    return contact.customFields?.[key] ?? null;
  }
  return (contact as unknown as Record<string, unknown>)[path] ?? null;
}

function evalOne(contact: Contact, c: Condition, ctx?: ConditionContext): boolean {
  const raw = getField(contact, c.field, ctx);
  const val = (c.value ?? "").trim();
  switch (c.op) {
    case "is_set":
      return raw !== null && raw !== undefined && raw !== "";
    case "not_set":
      return raw === null || raw === undefined || raw === "";
    case "has_tag":
      return Array.isArray(contact.tags) && contact.tags.includes(val);
    case "in_stage":
      return (contact.pipelineStage ?? "") === val;
    case "source_is":
      return (contact.source ?? "") === val;
    case "equals":
      return String(raw ?? "") === val;
    case "not_equals":
      return String(raw ?? "") !== val;
    case "contains":
      return String(raw ?? "").toLowerCase().includes(val.toLowerCase());
    default:
      return false;
  }
}

export function evalConditionGroup(
  group: ConditionGroup | undefined,
  contact: Contact,
  ctx?: ConditionContext,
): boolean {
  const all = group?.all ?? [];
  if (all.length === 0) return true;
  return group?.match === "any"
    ? all.some((c) => evalOne(contact, c, ctx))
    : all.every((c) => evalOne(contact, c, ctx));
}

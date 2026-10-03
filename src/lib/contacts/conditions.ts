import { REPLY_TEXT_FIELD } from "@/lib/workflows/catalog";
import type { Condition, ConditionGroup } from "@/types/workflows";
import type { Contact } from "@/types/contacts";

export { REPLY_TEXT_FIELD };

/**
 * Pure condition evaluator. Deliberately NOT `server-only`: the contacts
 * list evaluates saved smart lists in the browser with exactly the code the
 * workflow engine runs on the server, so a list and a trigger filter written
 * from the same ConditionGroup can never disagree. Server callers import via
 * `@/lib/workflows/conditions`, which re-exports this module.
 */

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

/**
 * Evaluate a workflow ConditionGroup against a contact. `match: "all"` (the
 * default) requires every condition; `match: "any"` requires at least one.
 * Used for both trigger filters and `if_else` branch nodes. An empty group
 * is always true (no filter).
 *
 * Trigger filters pass no context, so a `reply.text` condition there reads
 * null — a trigger fires before any reply exists. The builder does not offer
 * the field on a trigger, but nothing rejects it in stored JSON, so be aware
 * of the shape it degrades to: `is_set`/`contains`/`starts_with_word`/`equals` are
 * always false and `not_set`/`not_equals`/`not_contains` always TRUE. The
 * second is the trap — such a filter would match every contact rather than
 * none.
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

/**
 * `starts_with_word` — a whole leading WORD (or words), not a plain prefix:
 * `phone starts_with_word "082"` is false for "0821234567", by design.
 *
 * Both sides are trimmed (whitespace plus the zero-width U+200B, U+200C,
 * U+200D, U+2060, U+FEFF that phone keyboards and copy-paste leave at the
 * edges), lower-cased and NFC-normalised, so an accent typed precomposed or as
 * a combining mark compares equal. True when the field begins with the value
 * AND the value is followed by end-of-text or a character that is not a
 * letter, digit or combining mark (Unicode `\p{L}` / `\p{N}` / `\p{M}`).
 *
 * So "yes" matches "Yes", " Yes! ", "Yes, all good", "YES👍" but not
 * "Yesterday", "Yess", "Yesé" or "No, yes"; "cafe" does not match "café
 * latte". The rule holds even when the value itself ends in punctuation: the
 * NEXT character must still not be a letter or digit, so "yes," does not match
 * "yes,good". A blank value is false — a rule left empty must never match
 * every contact.
 */
const EDGE_SPACE = /^[\s\u200B\u200C\u200D\u2060\uFEFF]+|[\s\u200B\u200C\u200D\u2060\uFEFF]+$/g;
const foldWord = (s: string) => s.replace(EDGE_SPACE, "").toLowerCase().normalize("NFC");

function startsWithWord(field: string, value: string): boolean {
  const v = foldWord(value);
  if (!v) return false;
  const f = foldWord(field);
  return f.startsWith(v) && !/^[\p{L}\p{N}\p{M}]/u.test(f.slice(v.length));
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
    // A contact with no tags array at all is EXCLUDED FROM NOTHING, so this is
    // true for it — the same answer as an empty array, and the opposite of
    // `has_tag`. Reading it as false would silently drop every contact whose
    // tags field is missing from a campaign that merely means "not opted out".
    case "not_has_tag":
      return !(Array.isArray(contact.tags) && contact.tags.includes(val));
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
    // The exact negation of `contains`, value for value — including a blank
    // value, which `contains` treats as matching everything (every string
    // includes ""), so `not_contains ""` matches nothing. A missing field
    // contains nothing, so it does NOT contain any non-blank value: true.
    case "not_contains":
      return !String(raw ?? "").toLowerCase().includes(val.toLowerCase());
    case "starts_with_word":
      return startsWithWord(String(raw ?? ""), val);
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

import "server-only";

import type { WorkflowPatch } from "@/lib/server/workflows-service";
import { CONDITION_OPS, TRIGGER_LABELS } from "@/lib/workflows/catalog";
import { sanitizeNodes } from "@/lib/workflows/sanitize-nodes";
import type { WorkflowReentry } from "@/types/workflows";
import { hasUnsafeText, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/** update_workflow's argument validation: the patch an agent may make. */

export const REENTRY: readonly WorkflowReentry[] = ["every_time", "unless_active", "once_ever"];
export const EDITABLE = ["name", "trigger", "reentry", "nodes", "startNodeId"] as const;
const MAX_NODES = 100;
const MAX_JSON = 50_000;
const MAX_CONDITIONS = 50;
const MAX_DEPTH = 20;
const OPS: readonly string[] = CONDITION_OPS.map((o) => o.value);
/** Every step id the builder (randomUUID, or `n_<base36>`) and the starter
 *  templates (`n1`…) make; nothing invisible or look-alike can hide in one. */
const STEP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const stepRef = (v: unknown) => v === null || v === undefined || (typeof v === "string" && STEP_ID.test(v));

const TOO_DEEP = "(too deep)";

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

/**
 * The first key anywhere in `v` that could reach an object's prototype once
 * code copies or spreads it (`__proto__`, any `__x__`, `constructor`,
 * `prototype`), or a nesting too deep to walk; null when none.
 */
function badKey(v: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(v)) {
    for (const x of v) {
      const bad = badKey(x, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  if (!v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if (/^__.*__$/.test(k) || k === "constructor" || k === "prototype") return JSON.stringify(k.slice(0, 40));
    const bad = badKey(x, depth + 1);
    if (bad) return bad;
  }
  return null;
}

/** A trigger's filters, exactly as the builder's conditions editor makes them. */
function filtersProblem(f: unknown): string | null {
  if (!plain(f) || Object.keys(f).some((k) => k !== "all" && k !== "match")) return "must be { all: [...], match? }";
  if (f.match !== undefined && f.match !== "all" && f.match !== "any") return "match must be all or any";
  if (!Array.isArray(f.all) || f.all.length > MAX_CONDITIONS) return `all must be a list of at most ${MAX_CONDITIONS} conditions`;
  for (const c of f.all) {
    if (!plain(c) || Object.keys(c).some((k) => k !== "field" && k !== "op" && k !== "value")) {
      return "each condition must be { field, op, value? }";
    }
    if (typeof c.field !== "string" || c.field.length > 200) return "a condition's field must be text";
    if (typeof c.op !== "string" || !OPS.includes(c.op)) return `a condition's op must be one of ${OPS.join(", ")}`;
    if (c.value !== undefined && (typeof c.value !== "string" || c.value.length > 1000)) return "a condition's value must be text";
  }
  return null;
}

/** The patch an agent's args ask for; `status` is never read. */
export function patchOf(raw: unknown): { ok: true; patch: WorkflowPatch } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const patch: WorkflowPatch = {};
  if (r.name !== undefined) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name || name.length > 120 || hasUnsafeText(name)) {
      return { ok: false, error: `name must be 1-120 characters of text, none that ${UNSAFE_TEXT_MESSAGE}` };
    }
    patch.name = name;
  }
  if (r.reentry !== undefined) {
    if (!REENTRY.includes(r.reentry as WorkflowReentry)) return { ok: false, error: `reentry must be one of ${REENTRY.join(", ")}` };
    patch.reentry = r.reentry as WorkflowReentry;
  }
  // Walked before anything copies them: a copy would act on such a key.
  const bad = badKey(r.trigger) ?? badKey(r.nodes);
  if (bad === TOO_DEEP) return { ok: false, error: `the trigger and steps can be nested at most ${MAX_DEPTH} levels deep` };
  if (bad) return { ok: false, error: `the trigger and steps can't use the key ${bad}` };
  if (r.trigger !== undefined) {
    const t = r.trigger;
    if (!plain(t) || typeof t.type !== "string" || !Object.hasOwn(TRIGGER_LABELS, t.type)) {
      return { ok: false, error: `trigger must be an object whose type is one of ${Object.keys(TRIGGER_LABELS).join(", ")}` };
    }
    const problem = t.filters === undefined ? null : filtersProblem(t.filters);
    if (problem) return { ok: false, error: `trigger.filters ${problem}` };
    const trigger = JSON.parse(JSON.stringify({ ...t, filters: t.filters ?? { all: [] } }));
    if (JSON.stringify(trigger).length > MAX_JSON) return { ok: false, error: "the trigger is too large" };
    patch.trigger = trigger;
  }
  if (r.nodes !== undefined) {
    const nodes = plain(r.nodes) ? sanitizeNodes(r.nodes) : null;
    if (!nodes) return { ok: false, error: "nodes must be a map of step id → { type, config, next, branches } with known step types" };
    if (Object.keys(nodes).length > MAX_NODES) return { ok: false, error: `a workflow can have at most ${MAX_NODES} steps` };
    for (const [id, n] of Object.entries(nodes)) {
      if (!STEP_ID.test(id) || !stepRef(n.next) || !stepRef(n.branches?.whenTrue) || !stepRef(n.branches?.whenFalse)) {
        return { ok: false, error: "step ids (and next / branches) must be 1-64 letters, digits, _ or -" };
      }
      const problem = n.type === "if_else" && n.config.conditions !== undefined ? filtersProblem(n.config.conditions) : null;
      if (problem) return { ok: false, error: `step ${id}'s conditions ${problem}` };
    }
    const json = JSON.stringify(nodes);
    if (json.length > MAX_JSON) return { ok: false, error: "the steps are too large" };
    patch.nodes = JSON.parse(json);
  }
  if (r.startNodeId !== undefined) {
    if (!stepRef(r.startNodeId)) return { ok: false, error: "startNodeId must be a step id (1-64 letters, digits, _ or -) or null" };
    if (typeof r.startNodeId === "string" && patch.nodes && !Object.hasOwn(patch.nodes, r.startNodeId)) {
      return { ok: false, error: "startNodeId must be one of the steps" };
    }
    patch.startNodeId = r.startNodeId as string | null;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: `give at least one of ${EDITABLE.join(", ")}` };
  return { ok: true, patch };
}

import { describe, expect, it } from "vitest";
import { patchOf } from "./workflow-args";

/** update_workflow's argument validation (the route tests cover the rest). */

const NEW_STEPS = { n2: { id: "n2", type: "send_sms", config: { body: "New text" }, next: null } };

describe("patchOf refuses", () => {
  it.each([
    ["a __proto__ key in a step's config", () => ({ nodes: JSON.parse('{"n1":{"type":"webhook","config":{"__proto__":{"url":"x"}}}}') }), '"__proto__"'],
    ["a __proto__ step id", () => ({ nodes: JSON.parse('{"__proto__":{"type":"send_sms","config":{}}}') }), '"__proto__"'],
    ["a constructor key in the trigger", () => ({ trigger: JSON.parse('{"type":"contact.created","constructor":{"x":1}}') }), '"constructor"'],
    ["a prototype key deep in a step", () => ({ nodes: { n1: { type: "send_sms", config: { a: [{ prototype: 1 }] } } } }), '"prototype"'],
    ["a __x__ key", () => ({ nodes: { n1: { type: "send_sms", config: { __x__: 1 } } } }), '"__x__"'],
  ])("%s", (_label, patch, key) => {
    expect(patchOf(patch())).toEqual({ ok: false, error: `the trigger and steps can't use the key ${key}` });
  });

  it.each([
    ["an unknown trigger type", { trigger: { type: "toString" } }],
    ["trigger filters that aren't an object", { trigger: { type: "contact.created", filters: "all" } }],
    ["an unknown step type", { nodes: { n1: { type: "launch_rocket", config: {} } } }],
    ["too many steps", { nodes: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`n${i}`, { type: "send_sms", config: {} }])) }],
    ["a start step that isn't one of the steps", { nodes: NEW_STEPS, startNodeId: "n9" }],
    ["an inherited-property start step", { nodes: NEW_STEPS, startNodeId: "toString" }],
    ["an invisible character in the name", { name: "We\u200blcome" }],
    ["an unknown re-entry", { reentry: "sometimes" }],
    ["nothing to change (status is never read)", { status: "active" }],
  ])("%s", (_label, patch) => {
    expect(patchOf(patch)).toMatchObject({ ok: false });
  });
});

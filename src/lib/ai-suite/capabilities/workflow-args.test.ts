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

describe("step ids", () => {
  const BLAST = { type: "send_sms", config: { body: "BLAST" }, next: null };
  const BENIGN = { type: "send_sms", config: { body: "Hello" }, next: null };
  it.each([
    ["a zero-width look-alike start step", { nodes: { n1: BENIGN, "n1\u200b": BLAST }, startNodeId: "n1\u200b" }],
    ["a trailing-space look-alike start step", { nodes: { n1: BENIGN, "n1 ": BLAST }, startNodeId: "n1 " }],
    ["a look-alike start step alone", { startNodeId: "n1 " }],
    ["a look-alike next", { nodes: { n1: { ...BENIGN, next: "n2\u200b" }, n2: BLAST } }],
    ["a look-alike yes-branch", { nodes: { n1: { type: "if_else", config: {}, branches: { whenTrue: "n2 ", whenFalse: null } }, n2: BLAST } }],
    ["a look-alike no-branch", { nodes: { n1: { type: "if_else", config: {}, branches: { whenTrue: null, whenFalse: "n2 " } }, n2: BLAST } }],
    ["an over-long id", { nodes: { ["n".repeat(65)]: BENIGN } }],
  ])("%s → refused", (_label, patch) => {
    expect(patchOf(patch)).toMatchObject({ ok: false });
  });

  it("ids the builder and the templates make are accepted", () => {
    const uuid = "3f2b8c1e-9a4d-4e7b-8c2a-1f0e9d8c7b6a";
    const nodes = {
      n1: { ...BENIGN, next: uuid },
      [uuid]: { type: "if_else", config: { conditions: { all: [{ field: "email", op: "is_set" }] } }, branches: { whenTrue: "n_abc123", whenFalse: null } },
      n_abc123: BENIGN,
    };
    expect(patchOf({ nodes, startNodeId: "n1" })).toMatchObject({ ok: true });
  });
});

describe("if_else conditions", () => {
  it.each([
    ["all as a number", { all: 5 }],
    ["an unknown op", { all: [{ field: "email", op: "bogus" }] }],
  ])("%s → refused", (_label, conditions) => {
    expect(patchOf({ nodes: { n1: { type: "if_else", config: { conditions } } } })).toMatchObject({ ok: false });
  });
});

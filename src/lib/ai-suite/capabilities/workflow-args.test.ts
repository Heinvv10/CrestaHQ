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

  it("nesting past the depth cap", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 25; i++) deep = { d: deep };
    expect(patchOf({ nodes: { n1: { type: "send_sms", config: { deep } } } })).toEqual({
      ok: false, error: "the trigger and steps can be nested at most 20 levels deep",
    });
  });

  it.each([
    ["an unknown trigger type", { trigger: { type: "toString" } }, /^trigger must be an object whose type is one of form\.submitted, contact\.created, /],
    ["trigger filters that aren't an object", { trigger: { type: "contact.created", filters: "all" } }, /^trigger\.filters must be \{ all: \[\.\.\.\], match\? \}$/],
    ["an unknown step type", { nodes: { n1: { type: "launch_rocket", config: {} } } }, /^nodes must be a map of step id → \{ type, config, next, branches \} with known step types$/],
    ["too many steps", { nodes: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`n${i}`, { type: "send_sms", config: {} }])) }, /^a workflow can have at most 100 steps$/],
    ["a start step that isn't one of the steps", { nodes: NEW_STEPS, startNodeId: "n9" }, /^startNodeId must be one of the steps$/],
    ["an inherited-property start step", { nodes: NEW_STEPS, startNodeId: "toString" }, /^startNodeId must be one of the steps$/],
    ["an invisible character in the name", { name: "We\u200blcome" }, /^name must be 1-120 characters of text, none that contains characters/],
    ["an unknown re-entry", { reentry: "sometimes" }, /^reentry must be one of every_time, unless_active, once_ever$/],
    ["nothing to change (status is never read)", { status: "active" }, /^give at least one of name, trigger, reentry, nodes, startNodeId$/],
  ])("%s", (_label, patch, error) => {
    expect(patchOf(patch)).toEqual({ ok: false, error: expect.stringMatching(error) });
  });
});

describe("step ids", () => {
  const BLAST = { type: "send_sms", config: { body: "BLAST" }, next: null };
  const BENIGN = { type: "send_sms", config: { body: "Hello" }, next: null };
  const IDS = "step ids (and next / branches) must be 1-64 letters, digits, _ or -";
  const START = "startNodeId must be a step id (1-64 letters, digits, _ or -) or null";
  it.each([
    ["a zero-width look-alike start step", { nodes: { n1: BENIGN, "n1\u200b": BLAST }, startNodeId: "n1\u200b" }, IDS],
    ["a trailing-space look-alike start step", { nodes: { n1: BENIGN, "n1 ": BLAST }, startNodeId: "n1 " }, IDS],
    ["a look-alike start step alone", { startNodeId: "n1 " }, START],
    ["a look-alike next", { nodes: { n1: { ...BENIGN, next: "n2\u200b" }, n2: BLAST } }, IDS],
    ["a look-alike yes-branch", { nodes: { n1: { type: "if_else", config: {}, branches: { whenTrue: "n2 ", whenFalse: null } }, n2: BLAST } }, IDS],
    ["a look-alike no-branch", { nodes: { n1: { type: "if_else", config: {}, branches: { whenTrue: null, whenFalse: "n2 " } }, n2: BLAST } }, IDS],
    ["an over-long id", { nodes: { ["n".repeat(65)]: BENIGN } }, IDS],
  ])("%s → refused", (_label, patch, error) => {
    expect(patchOf(patch)).toEqual({ ok: false, error });
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
    ["all as a number", { all: 5 }, /^step n1's conditions all must be a list of at most 50 conditions$/],
    ["an unknown op", { all: [{ field: "email", op: "bogus" }] }, /^step n1's conditions a condition's op must be one of equals, /],
  ])("%s → refused", (_label, conditions, error) => {
    expect(patchOf({ nodes: { n1: { type: "if_else", config: { conditions } } } })).toEqual({ ok: false, error: expect.stringMatching(error) });
  });
});

describe("text condition ops", () => {
  it("accepts starts_with_word and not_contains on an if_else and a trigger filter", () => {
    const conditions = {
      match: "all",
      all: [
        { field: "reply.text", op: "starts_with_word", value: "yes" },
        { field: "reply.text", op: "not_contains", value: "but" },
      ],
    };
    expect(
      patchOf({
        trigger: { type: "contact.created", filters: conditions },
        nodes: { n1: { type: "if_else", config: { conditions } } },
      }),
    ).toMatchObject({
      ok: true,
      patch: { trigger: { filters: conditions }, nodes: { n1: { config: { conditions } } } },
    });
  });
});

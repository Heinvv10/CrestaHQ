import { describe, expect, it } from "vitest";
import { ADDABLE_TYPES } from "@/lib/workflows/catalog";
import { MAX_DEPTH, MAX_ENTITIES, MAX_NODES, parseSnapshotFile } from "./snapshot-file";

const nested = (depth: number) => {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < depth; i++) { cur.x = {}; cur = cur.x as Record<string, unknown>; }
  return root;
};
const workflowWith = (nodes: Record<string, unknown>) => ({
  sourceId: "w", name: "W", status: "draft", trigger: { type: "contact.created", filters: { all: [] } }, nodes,
});
const waitNode = (id: string, config: Record<string, unknown> = { seconds: 1 }) => ({ id, type: "wait", config });

const file = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  format: "leadstack-snapshot", version: 1, name: "N", payload, ...extra,
});

describe("parseSnapshotFile", () => {
  it("accepts an empty payload and fills the required arrays", () => {
    const out = parseSnapshotFile(file({}));
    expect(out).toMatchObject({ ok: true, payload: { forms: [], workflows: [], messageTemplates: [], products: [], customFields: [], aiProfile: null } });
  });

  it("keeps only whitelisted, correctly typed fields", () => {
    const out = parseSnapshotFile(file({
      products: [{ sourceId: "p", name: "A", description: "", unitPriceCents: 1, currency: "USD", active: true, stripePriceId: "price_x", createdByUid: "u" }],
    }));
    expect(out.ok && out.payload.products[0]).toEqual({ sourceId: "p", name: "A", description: "", unitPriceCents: 1, currency: "USD", active: true });
  });

  it("refuses a wrongly typed field rather than coercing it", () => {
    const out = parseSnapshotFile(file({
      products: [{ sourceId: "p", name: "A", description: "", unitPriceCents: "1", currency: "USD", active: true }],
    }));
    expect(out).toEqual({ ok: false, error: "That snapshot file is malformed." });
  });

  it("accepts every step type the builder offers, so an exported workflow imports", () => {
    const nodes = Object.fromEntries(ADDABLE_TYPES.map((type, i) => [`n${i}`, { id: `n${i}`, type, config: {} }]));
    expect(parseSnapshotFile(file({ workflows: [workflowWith(nodes)] })).ok).toBe(true);
  });

  it("refuses a node whose key and id disagree", () => {
    const out = parseSnapshotFile(file({
      workflows: [{ sourceId: "w", name: "W", status: "draft", trigger: { type: "contact.created", filters: { all: [] } },
        nodes: { n1: { id: "n9", type: "wait", config: { seconds: 1 } } } }],
    }));
    expect(out.ok).toBe(false);
  });

  it("refuses nesting past MAX_DEPTH and accepts nesting at it", () => {
    // config sits 4 levels down (payload → workflows[] → workflow → nodes → node → config).
    const at = file({ workflows: [workflowWith({ n1: waitNode("n1", nested(MAX_DEPTH - 6)) })] });
    expect(parseSnapshotFile(at).ok).toBe(true);
    const past = file({ workflows: [workflowWith({ n1: waitNode("n1", nested(MAX_DEPTH)) })] });
    expect(parseSnapshotFile(past)).toEqual({ ok: false, error: "That snapshot file is malformed." });
    // Far past: must be a refusal, never a RangeError.
    const far = file({ workflows: [workflowWith({ n1: waitNode("n1", nested(50_000)) })] });
    expect(parseSnapshotFile(far).ok).toBe(false);
  });

  it("caps entities per array and nodes per workflow", () => {
    const product = { sourceId: "p", name: "A", description: "", unitPriceCents: 1, currency: "USD", active: true };
    expect(parseSnapshotFile(file({ products: Array(MAX_ENTITIES).fill(product) })).ok).toBe(true);
    expect(parseSnapshotFile(file({ products: Array(MAX_ENTITIES + 1).fill(product) })).ok).toBe(false);
    const tooManyForms = file({ forms: Array(MAX_ENTITIES + 1).fill({ sourceId: "f", name: "F", slug: "f", enabled: true, fields: [] }) });
    expect(parseSnapshotFile(tooManyForms).ok).toBe(false);
    const nodes = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, waitNode(`n${i}`)]));
    expect(parseSnapshotFile(file({ workflows: [workflowWith(nodes(MAX_NODES))] })).ok).toBe(true);
    expect(parseSnapshotFile(file({ workflows: [workflowWith(nodes(MAX_NODES + 1))] })).ok).toBe(false);
  });

  it("caps oversized strings and refuses a non-integer or missing version", () => {
    const out = parseSnapshotFile(file({ messageTemplates: [{ sourceId: "t", type: "sms", name: "n", body: "y".repeat(50_000) }] }));
    expect(out.ok && (out.payload.messageTemplates[0].body as string).length).toBe(20_000);
    expect(parseSnapshotFile(file({}, { version: 1.5 })).ok).toBe(false);
    expect(parseSnapshotFile(file({}, { version: undefined })).ok).toBe(false);
    expect(parseSnapshotFile(file({}, { name: "  " })).ok).toBe(false);
  });
});

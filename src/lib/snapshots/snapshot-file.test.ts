import { describe, expect, it } from "vitest";
import { parseSnapshotFile } from "./snapshot-file";

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

  it("refuses a node whose key and id disagree", () => {
    const out = parseSnapshotFile(file({
      workflows: [{ sourceId: "w", name: "W", status: "draft", trigger: { type: "contact.created", filters: { all: [] } },
        nodes: { n1: { id: "n9", type: "wait", config: { seconds: 1 } } } }],
    }));
    expect(out.ok).toBe(false);
  });

  it("caps oversized strings and refuses a non-integer or missing version", () => {
    const out = parseSnapshotFile(file({ messageTemplates: [{ sourceId: "t", type: "sms", name: "n", body: "y".repeat(50_000) }] }));
    expect(out.ok && (out.payload.messageTemplates[0].body as string).length).toBe(20_000);
    expect(parseSnapshotFile(file({}, { version: 1.5 })).ok).toBe(false);
    expect(parseSnapshotFile(file({}, { version: undefined })).ok).toBe(false);
    expect(parseSnapshotFile(file({}, { name: "  " })).ok).toBe(false);
  });
});

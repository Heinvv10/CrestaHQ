import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * "Import from file" through the real owner gate, parser and scrub over an
 * in-memory Firestore. The file is untrusted: every refusal here is one an
 * edited file could otherwise slip past.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_owner: { status: "active", agencyId: "ag_1", agencyRole: "owner" },
  u_member: { status: "active", agencyId: "ag_1", agencyRole: null },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ uid, customClaims: claims[uid] }) }),
}));
const { POST } = await import("./route");

function post(body: string, uid = "u_owner", headers: Record<string, string> = {}) {
  return POST(
    new Request("https://app.test/api/agency/snapshots/import-file", {
      method: "POST",
      headers: { "x-user-uid": uid, ...headers },
      body,
    }),
  );
}

const goodFile = () => ({
  format: "leadstack-snapshot",
  version: 1,
  name: "Shared starter",
  exportedAt: "2026-09-15T00:00:00.000Z",
  payload: {
    forms: [{
      sourceId: "f1", name: "Lead", slug: "lead", enabled: true,
      fields: [{ id: "x", type: "text", label: "Name", placeholder: "", required: true, options: [], mapsTo: "name" }],
      settings: { redirectUrl: "https://sharer.example/thanks", autoTags: [] },
      submissionCount: 999, agencyId: "ag_sharer", secretExtra: "drop me",
    }],
    messageTemplates: [{ sourceId: "t1", type: "sms", name: "Hi", body: "hello", subAccountId: "sa_sharer" }],
    products: [{ sourceId: "p1", name: "Call-out", description: "", unitPriceCents: 5000, currency: "ZAR", active: true }],
    customFields: [{ sourceId: "c1", entity: "contact", key: "k", label: "K", type: "text", options: [], required: false, order: 0 }],
    workflows: [{
      sourceId: "w1", name: "Flow", status: "active", startNodeId: "n1",
      trigger: { type: "form.submitted", filters: { all: [] }, formId: "f1" },
      nodes: {
        n1: { id: "n1", type: "notify", config: { recipient: "custom", to: "leak@sharer.example", subject: "s", body: "b" }, next: "n2" },
        n2: { id: "n2", type: "webhook", config: { url: "https://sharer.example/hook" } },
      },
    }],
    aiProfile: { systemPrompt: "You are helpful.", hoursStart: 8, hoursEnd: 17, timezone: "UTC", escalationKeywords: [] },
  },
});

const stored = () => mem.list("agencies/ag_1/snapshots");

beforeEach(() => mem.clear());

describe("POST /api/agency/snapshots/import-file", () => {
  it("stores a scrubbed copy stamped for the importer, dropping unknown fields", async () => {
    const res = await post(JSON.stringify(goodFile()));
    expect(res.status).toBe(200);
    const [doc] = stored();
    expect(doc).toMatchObject({
      agencyId: "ag_1", createdByUid: "u_owner", name: "Shared starter", version: 1,
      sourceSubAccountId: null, importedFrom: { via: "file" },
    });
    const text = JSON.stringify(doc);
    for (const leak of ["secretExtra", "ag_sharer", "sa_sharer", "submissionCount", "leak@sharer.example", "sharer.example/hook", "sharer.example/thanks"]) {
      expect(text, `stored copy carries ${leak}`).not.toContain(leak);
    }
    const payload = doc.payload as { forms: Array<{ sourceId: string }>; workflows: Array<{ trigger: { formId: string }; nodes: Record<string, { config: Record<string, unknown> }> }> };
    expect(payload.forms[0].sourceId).not.toBe("f1");
    expect(payload.workflows[0].trigger.formId).toBe(payload.forms[0].sourceId);
    expect(payload.workflows[0].nodes.n1.config).toMatchObject({ recipient: "owner", to: "" });
    expect(payload.workflows[0].nodes.n2.config.url).toBe("");
  });

  it("refuses malformed JSON, the wrong format, and a newer version", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ ...goodFile(), format: "ghl-snapshot" }))).status).toBe(400);
    expect((await post(JSON.stringify({ ...goodFile(), version: 2 }))).status).toBe(400);
    expect(stored()).toHaveLength(0);
  });

  it("refuses an entity missing a required field or a node of an unknown type", async () => {
    const noName = goodFile();
    delete (noName.payload.products[0] as Partial<{ name: string }>).name;
    expect((await post(JSON.stringify(noName))).status).toBe(400);

    const badNode = goodFile();
    badNode.payload.workflows[0].nodes.n2.type = "run_script";
    expect((await post(JSON.stringify(badNode))).status).toBe(400);
    expect(stored()).toHaveLength(0);
  });

  it("refuses a node config nested far too deep as malformed, not as a crash", async () => {
    // Splice a 100k-deep object (under the byte cap, so depth is what refuses it) into the webhook config as raw text —
    // JSON.stringify would overflow building it, which is rather the point.
    const depth = 100_000;
    const marker = "\"__DEEP__\"";
    const deep = goodFile();
    (deep.payload.workflows[0].nodes.n2.config as Record<string, unknown>).inner = "__DEEP__";
    const text = JSON.stringify(deep).replace(marker, "{\"x\":".repeat(depth) + "1" + "}".repeat(depth));
    const res = await post(text);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That snapshot file is malformed." });
    expect(stored()).toHaveLength(0);
  });

  it("refuses an oversized body, declared or actual, and a non-owner", async () => {
    const declared = await post(JSON.stringify(goodFile()), "u_owner", { "content-length": String(1024 * 1024) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "That snapshot file is too large to import (over 900 KB)." });
    const big = goodFile();
    big.payload.messageTemplates[0].body = "x".repeat(900 * 1024 + 1);
    expect((await post(JSON.stringify(big))).status).toBe(413);

    // No content-length, streamed in chunks, never valid JSON: the cap must
    // trip on the byte count while streaming, before any parse.
    let pulled = 0;
    const chunk = new TextEncoder().encode("{".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 4 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const streamed = await POST(
      new Request("https://app.test/api/agency/snapshots/import-file", {
        method: "POST", headers: { "x-user-uid": "u_owner" }, body: stream, duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    // Cancelled once over the cap, not drained to the end.
    expect(pulled).toBeLessThan(2 * 1024 * 1024);
    expect((await post(JSON.stringify(goodFile()), "u_member")).status).toBe(403);
    expect(stored()).toHaveLength(0);
  });
});

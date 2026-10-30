import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { SnapshotPayload } from "@/types/snapshots";
import { pushTemplate } from "./push";

/**
 * Runs the REAL applySnapshot against the in-memory store, so "workflows
 * land as drafts" and "the trigger form is remapped" are apply's behaviour,
 * not a re-statement of it. The memory store has no `batch`; the shim below
 * funnels batch sets through ordinary doc writes.
 */
const mem = createMemoryFirestore();
const db = Object.assign(mem.db, {
  batch: () => {
    const pending: Array<[{ set: (d: Record<string, unknown>) => Promise<void> }, Record<string, unknown>]> = [];
    return {
      set: (ref: { set: (d: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
        void pending.push([ref, data]),
      commit: async () => {
        for (const [ref, data] of pending) await ref.set(data);
      },
    };
  },
}) as unknown as Firestore;

const scope = { agencyId: "ag1", createdByUid: "owner", templateId: "tpl1" };

const workflowPayload = (): SnapshotPayload => ({
  forms: [
    { sourceId: "f1", name: "Quote form", slug: "quote", fields: [], settings: {}, enabled: true } as unknown as SnapshotPayload["forms"][number],
  ],
  messageTemplates: [],
  products: [],
  workflows: [
    {
      sourceId: "w1",
      name: "Follow up",
      status: "active",
      trigger: { type: "form.submitted", formId: "f1", filters: { all: [], match: "all" } },
      startNodeId: "n1",
      nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null } },
    } as unknown as SnapshotPayload["workflows"][number],
  ],
});

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1" });
  mem.seed("subAccounts/foreign", { agencyId: "ag2" });
});

describe("pushTemplate", () => {
  it("creates a draft workflow per target, remapped to the pushed form and stamped with the target's tenancy", async () => {
    const results = await pushTemplate(db, workflowPayload(), ["sa1", "sa2"], scope);
    const none = { forms: 0, messageTemplates: 0, workflows: 0 };
    expect(results).toEqual([
      { subAccountId: "sa1", ok: true, created: { forms: 1, messageTemplates: 0, workflows: 1 }, skipped: none },
      { subAccountId: "sa2", ok: true, created: { forms: 1, messageTemplates: 0, workflows: 1 }, skipped: none },
    ]);
    for (const sa of ["sa1", "sa2"]) {
      const wfs = mem.list("workflows").filter((w) => w.subAccountId === sa);
      const forms = mem.list("forms").filter((f) => f.subAccountId === sa);
      expect(wfs).toHaveLength(1);
      expect(forms).toHaveLength(1);
      const w = wfs[0];
      expect(w.status).toBe("draft");
      expect(w.agencyId).toBe("ag1");
      expect(w.createdByUid).toBe("owner");
      expect(w.id).not.toBe("w1");
      expect(w).not.toHaveProperty("sourceId");
      expect((w.trigger as { formId: string }).formId).toBe(forms[0].id);
      expect(w.stats).toEqual({ enrolled: 0, completed: 0 });
    }
  });

  it("refuses a target outside the caller's agency per-target and still serves the rest", async () => {
    const results = await pushTemplate(db, workflowPayload(), ["foreign", "sa1", "ghost"], scope);
    expect(results.map((r) => [r.subAccountId, r.ok])).toEqual([
      ["foreign", false],
      ["sa1", true],
      ["ghost", false],
    ]);
    expect(results[0].error).toBe("Sub-account not found in this agency.");
    expect(results[0].created).toEqual({ forms: 0, messageTemplates: 0, workflows: 0 });
    // Nothing was written into the foreign tenant.
    expect(mem.list("workflows").filter((w) => w.subAccountId === "foreign")).toHaveLength(0);
    expect(mem.list("workflows").filter((w) => w.subAccountId === "sa1")).toHaveLength(1);
  });

  it("pushes an email template with fresh identity", async () => {
    const payload: SnapshotPayload = {
      forms: [],
      products: [],
      workflows: [],
      messageTemplates: [
        { sourceId: "t1", type: "email", name: "Welcome", subject: "Hi", body: "Hello" } as unknown as SnapshotPayload["messageTemplates"][number],
      ],
    };
    const results = await pushTemplate(db, payload, ["sa2"], scope);
    expect(results[0]).toMatchObject({ ok: true, created: { messageTemplates: 1, forms: 0, workflows: 0 } });
    const t = mem.list("message_templates")[0];
    expect(t.subAccountId).toBe("sa2");
    expect(t.id).not.toBe("t1");
    expect(t.name).toBe("Welcome");
  });
});

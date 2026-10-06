import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { applySnapshot } from "./apply";
import { planSnapshotApply } from "./apply-plan";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * `planSnapshotApply` is the dry count the agent apply's approval preview
 * shows (AGENCY_AGENT_API_PLAN.md A4a-2): what applySnapshot would create and
 * skip in the target right now, by applySnapshot's own rules. Each case runs
 * the plan, then the real apply on the same store, and the two must agree.
 */

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;
const scope = { agencyId: "ag1", createdByUid: "owner1", snapshotId: "snap1" };

function payload(over: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    forms: [
      { sourceId: "f1", name: "Lead", slug: "lead", fields: [], settings: {}, enabled: true },
      { sourceId: "f2", name: "Draft", slug: "draft", fields: [], settings: {}, enabled: false },
    ] as unknown as SnapshotPayload["forms"],
    messageTemplates: [{ sourceId: "t1", type: "email", name: "Hi", subject: "Hi", body: "Hello" }] as unknown as SnapshotPayload["messageTemplates"],
    products: [{ sourceId: "p1", name: "Install" }] as unknown as SnapshotPayload["products"],
    workflows: [
      {
        sourceId: "w1", name: "Follow up", status: "active", startNodeId: "n1",
        trigger: { type: "form.submitted", formId: "f1", filters: { all: [], match: "all" } },
        nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null } },
      },
    ] as unknown as SnapshotPayload["workflows"],
    customFields: [
      { sourceId: "cf1", entity: "contact", key: "install_date", label: "Install date" },
      { sourceId: "cf2", entity: "contact", key: "plan", label: "Plan" },
    ] as unknown as SnapshotPayload["customFields"],
    aiProfile: { systemPrompt: "You are helpful.", hoursStart: 8, hoursEnd: 17, timezone: "UTC", escalationKeywords: [] },
    ...over,
  };
}

const counts = (r: Awaited<ReturnType<typeof applySnapshot>>) => ({
  create: {
    forms: r.formsCreated, messageTemplates: r.templatesCreated, products: r.productsCreated,
    workflows: r.workflowsCreated, customFields: r.customFieldsCreated,
  },
  skip: {
    forms: r.formsSkipped, messageTemplates: r.templatesSkipped, products: r.productsSkipped,
    workflows: r.workflowsSkipped, customFields: r.customFieldsSkipped,
  },
});

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa_dst", { agencyId: "ag1" });
});

describe("planSnapshotApply agrees with applySnapshot", () => {
  it("an empty target: everything created, the enabled form counted, the persona written", async () => {
    const plan = await planSnapshotApply(db, payload(), "sa_dst", "snap1");
    const result = await applySnapshot(db, payload(), "sa_dst", scope);
    expect({ create: plan.create, skip: plan.skip }).toEqual(counts(result));
    expect(plan.create).toEqual({ forms: 2, messageTemplates: 1, products: 1, workflows: 1, customFields: 2 });
    expect(plan.enabledForms).toBe(1);
    expect(plan.persona).toBe("written");
    expect(result.aiProfileApplied).toBe(true);
  });

  it("the plan reads only: nothing is written by it", async () => {
    const before = mem.all().length;
    await planSnapshotApply(db, payload(), "sa_dst", "snap1");
    expect(mem.all()).toHaveLength(before);
  });

  it("after a prior apply: every deterministic doc and taken key is a skip, the persona kept", async () => {
    await applySnapshot(db, payload(), "sa_dst", scope);
    const plan = await planSnapshotApply(db, payload(), "sa_dst", "snap1");
    const again = await applySnapshot(db, payload(), "sa_dst", scope);
    expect({ create: plan.create, skip: plan.skip }).toEqual(counts(again));
    expect(plan.create).toEqual({ forms: 0, messageTemplates: 0, products: 0, workflows: 0, customFields: 0 });
    expect(plan.enabledForms).toBe(0);
    expect(plan.persona).toBe("kept");
    expect(again.aiProfileApplied).toBe(false);
  });

  it("a key the target already defines and a persona already set: skipped and kept", async () => {
    mem.seed("subAccounts/sa_dst/customFields/own", { entity: "contact", key: "plan" });
    mem.seed("subAccounts/sa_dst/aiAgent/profile", { systemPrompt: "Mine." });
    const plan = await planSnapshotApply(db, payload(), "sa_dst", "snap1");
    const result = await applySnapshot(db, payload(), "sa_dst", scope);
    expect({ create: plan.create, skip: plan.skip }).toEqual(counts(result));
    expect(plan.skip.customFields).toBe(1);
    expect(plan.persona).toBe("kept");
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")?.systemPrompt).toBe("Mine.");
  });

  it("a blank persona prompt counts as none set; a snapshot without one says none", async () => {
    mem.seed("subAccounts/sa_dst/aiAgent/profile", { systemPrompt: "   " });
    expect((await planSnapshotApply(db, payload(), "sa_dst", "snap1")).persona).toBe("written");
    expect((await planSnapshotApply(db, payload({ aiProfile: null }), "sa_dst", "snap1")).persona).toBe("none");
  });

  it("another snapshot id is another set of deterministic docs: nothing skipped", async () => {
    await applySnapshot(db, payload(), "sa_dst", scope);
    const plan = await planSnapshotApply(db, payload(), "sa_dst", "snap2");
    expect(plan.create).toMatchObject({ forms: 2, messageTemplates: 1, products: 1, workflows: 1 });
  });
});

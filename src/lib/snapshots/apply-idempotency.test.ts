import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { applySnapshot } from "./apply";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * Regression coverage for the bug-hunt fix: `applySnapshot` used to mint a
 * fresh random id per doc on every call, so re-running it (deliberately, or
 * after a partial failure) duplicated everything it had already written.
 * Doc ids are now deterministic — derived from (target, snapshotId,
 * sourceId) — so a retry overwrites instead of duplicating, and apply
 * status is recorded on the target so a caller can see a partial run.
 */

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;

const scope = { agencyId: "ag1", createdByUid: "owner1", snapshotId: "snap1" };

function payload(): SnapshotPayload {
  return {
    forms: [
      { sourceId: "f1", name: "Lead form", slug: "lead", fields: [], settings: {}, enabled: true } as unknown as SnapshotPayload["forms"][number],
    ],
    messageTemplates: [
      { sourceId: "t1", type: "email", name: "Welcome", subject: "Hi", body: "Hello" } as unknown as SnapshotPayload["messageTemplates"][number],
    ],
    products: [
      { sourceId: "p1", name: "Install" } as unknown as SnapshotPayload["products"][number],
    ],
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
    customFields: [
      { sourceId: "cf1", entity: "contact", key: "install_date", label: "Install date" } as unknown as NonNullable<SnapshotPayload["customFields"]>[number],
    ],
  };
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa_dst", { agencyId: "ag1" });
});

describe("applySnapshot — idempotent retry", () => {
  it("applying the same snapshot twice does not duplicate any doc, and the second run reports everything as skipped", async () => {
    const first = await applySnapshot(db, payload(), "sa_dst", scope);
    expect(first).toMatchObject({
      formsCreated: 1,
      formsSkipped: 0,
      templatesCreated: 1,
      templatesSkipped: 0,
      productsCreated: 1,
      productsSkipped: 0,
      workflowsCreated: 1,
      workflowsSkipped: 0,
      customFieldsCreated: 1,
    });

    const second = await applySnapshot(db, payload(), "sa_dst", scope);
    expect(second).toMatchObject({
      formsCreated: 0,
      formsSkipped: 1,
      templatesCreated: 0,
      templatesSkipped: 1,
      productsCreated: 0,
      productsSkipped: 1,
      workflowsCreated: 0,
      workflowsSkipped: 1,
    });

    expect(mem.list("forms").filter((f) => f.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("message_templates").filter((t) => t.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("products").filter((p) => p.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("workflows").filter((w) => w.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("subAccounts/sa_dst/customFields")).toHaveLength(1);

    const status = mem.read(`subAccounts/sa_dst/snapshotApplies/${scope.snapshotId}`);
    expect(status?.status).toBe("completed");
  });

  it("never overwrites a workflow an operator has since activated and edited", async () => {
    await applySnapshot(db, payload(), "sa_dst", scope);
    const [applied] = mem.list("workflows").filter((w) => w.subAccountId === "sa_dst");

    // The operator reviewed the draft, activated it, and edited a node.
    await mem.db.doc(`workflows/${applied.id}`).update({
      status: "active",
      "nodes.n1.config.tag": "operator-edited",
    });
    const edited = mem.read(`workflows/${applied.id}`);
    expect(edited?.status).toBe("active");

    const result = await applySnapshot(db, payload(), "sa_dst", scope);
    expect(result.workflowsCreated).toBe(0);
    expect(result.workflowsSkipped).toBe(1);

    const stillThere = mem.list("workflows").filter((w) => w.subAccountId === "sa_dst");
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].status).toBe("active");
    expect(
      (stillThere[0].nodes as Record<string, { config: { tag: string } }>).n1.config.tag,
    ).toBe("operator-edited");
  });

  it("a failure mid-way then a retry completes with no duplicates", async () => {
    // Fail the run after the batched writes (forms/templates/products/
    // workflows/custom fields) succeed but before the persona transaction —
    // exactly the two-phase boundary applySnapshot has today.
    let failNext = true;
    const flaky = {
      ...db,
      runTransaction: (async (fn: unknown) => {
        if (failNext) {
          failNext = false;
          throw new Error("simulated mid-apply failure");
        }
        return (db as unknown as { runTransaction: (f: unknown) => Promise<unknown> }).runTransaction(fn);
      }) as Firestore["runTransaction"],
    } as unknown as Firestore;

    const withPersona: SnapshotPayload = {
      ...payload(),
      aiProfile: {
        systemPrompt: "You are Velo.",
        hoursStart: 8,
        hoursEnd: 17,
        timezone: "Africa/Johannesburg",
        escalationKeywords: ["manager"],
      },
    };

    await expect(applySnapshot(flaky, withPersona, "sa_dst", scope)).rejects.toThrow(
      "simulated mid-apply failure",
    );

    const afterFailure = mem.read(`subAccounts/sa_dst/snapshotApplies/${scope.snapshotId}`);
    expect(afterFailure?.status).toBe("failed");
    expect(afterFailure?.error).toBe("simulated mid-apply failure");
    // The batched half of the run DID land — that's exactly the partial
    // state a retry must not duplicate.
    expect(mem.list("forms").filter((f) => f.subAccountId === "sa_dst")).toHaveLength(1);

    const retry = await applySnapshot(db, withPersona, "sa_dst", scope);
    expect(retry.aiProfileApplied).toBe(true);
    // The batched half already landed on the failed run — the retry finds it
    // via the deterministic id and skips it rather than re-creating it.
    expect(retry).toMatchObject({
      formsCreated: 0,
      formsSkipped: 1,
      templatesCreated: 0,
      templatesSkipped: 1,
      productsCreated: 0,
      productsSkipped: 1,
      workflowsCreated: 0,
      workflowsSkipped: 1,
    });

    expect(mem.list("forms").filter((f) => f.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("message_templates").filter((t) => t.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("products").filter((p) => p.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("workflows").filter((w) => w.subAccountId === "sa_dst")).toHaveLength(1);
    expect(mem.list("subAccounts/sa_dst/customFields")).toHaveLength(1);

    const afterRetry = mem.read(`subAccounts/sa_dst/snapshotApplies/${scope.snapshotId}`);
    expect(afterRetry?.status).toBe("completed");
  });
});

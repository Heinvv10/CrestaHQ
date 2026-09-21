import { beforeEach, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { captureSnapshot } from "./capture";
import { captureEntity } from "@/lib/templates/capture";

/**
 * Workflow folders do not travel — like custom-field folders. A workflow's
 * `folderId` names a folder under the SOURCE sub-account; copied onto a
 * target it would dangle, or name an unrelated folder that happens to share
 * the id. Both capture paths (full snapshot, one-workflow template) must
 * strip it, so applied workflows land Unfiled.
 */

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One" });
  mem.seed("subAccounts/sa1/workflowFolders/fA", {
    name: "Sales", order: 0, agencyId: "ag1", subAccountId: "sa1", createdByUid: "u",
  });
  for (const [id, folderId] of [["w1", "fA"], ["w2", null], ["w3", undefined]] as const) {
    mem.seed(`workflows/${id}`, {
      name: id, status: "draft", startNodeId: null, nodes: {},
      trigger: { type: "contact.created", filters: { all: [] } },
      stats: { enrolled: 0, completed: 0 },
      agencyId: "ag1", subAccountId: "sa1", createdByUid: "u",
      ...(folderId === undefined ? {} : { folderId }),
    });
  }
});

it("snapshot capture: no workflow in the payload carries a folderId", async () => {
  const { workflows } = await captureSnapshot(db, "sa1");

  expect(workflows).toHaveLength(3);
  for (const w of workflows) expect(w).not.toHaveProperty("folderId");
});

it("template capture: the one workflow carries no folderId", async () => {
  const { payload } = await captureEntity(db, { agencyId: "ag1", subAccountId: "sa1" }, "workflow", "w1");

  expect(payload.workflows).toHaveLength(1);
  expect(payload.workflows[0]).not.toHaveProperty("folderId");
});

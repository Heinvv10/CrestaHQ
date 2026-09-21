import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { captureSnapshot } from "./capture";
import { applySnapshot } from "./apply";
import { toPortablePayload } from "./portable";
import { buildSnapshotFile, parseSnapshotFile } from "./snapshot-file";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * Workflow folders travel with a snapshot: capture reads them, apply mints
 * FRESH folders on the target and points every workflow at one of them (or
 * Unfiled). A copied source id would dangle on the target — or, worse, name a
 * folder that happens to exist there.
 *
 * Real capture and apply over an in-memory Firestore that honours `where`.
 */

const mem = createMemoryFirestore();
// apply commits through db.batch(); the memory store has none, so a batch is
// a list of sets applied in order on commit.
const db = {
  ...mem.db,
  batch: () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: { set: (d: unknown) => Promise<void> }, data: unknown) =>
        void ops.push(() => ref.set(data)),
      commit: async () => {
        for (const op of ops) await op();
      },
    };
  },
} as unknown as Firestore;

const scope = { agencyId: "ag1", createdByUid: "owner" };
const wf = (folderId?: string) => ({
  subAccountId: "sa_src", agencyId: "ag1", createdByUid: "u", name: `W ${folderId ?? "none"}`,
  status: "active", startNodeId: null, nodes: {}, stats: { enrolled: 3, completed: 1 },
  trigger: { type: "contact.created", filters: { all: [] } },
  ...(folderId ? { folderId } : {}),
});

beforeEach(() => {
  mem.clear();
  for (const [id, name, order] of [["fA", "Sales", 0], ["fB", "Ops", 1]] as const) {
    mem.seed(`subAccounts/sa_src/workflowFolders/${id}`, {
      name, order, agencyId: "ag1", subAccountId: "sa_src", createdByUid: "u",
    });
  }
  mem.seed("workflows/w1", wf("fA"));
  mem.seed("workflows/w2", wf("fB"));
  mem.seed("workflows/w3", wf());
  mem.seed("workflows/w4", wf("deleted"));
  // A target folder that shares a SOURCE id: a copied id would land here.
  mem.seed("subAccounts/sa_tgt/workflowFolders/fA", {
    name: "Target's own", order: 0, agencyId: "ag1", subAccountId: "sa_tgt", createdByUid: "t",
  });
});

/** Target workflows as { name, folder name | null }, and the target folders. */
function target() {
  const folders = mem.list("subAccounts/sa_tgt/workflowFolders");
  const byId = new Map(folders.map((f) => [f.id, f]));
  const workflows = mem
    .list("workflows")
    .filter((w) => w.subAccountId === "sa_tgt")
    .map((w) => {
      const folderId = w.folderId as string | null;
      // Every workflow points at a folder that exists on the target, or none.
      if (folderId !== null) expect(byId.has(folderId), `dangling ${folderId}`).toBe(true);
      return { name: w.name, folder: folderId ? byId.get(folderId)!.name : null };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { folders, workflows };
}

const EXPECTED = [
  { name: "W deleted", folder: null },
  { name: "W fA", folder: "Sales" },
  { name: "W fB", folder: "Ops" },
  { name: "W none", folder: null },
];

describe("snapshot capture + apply carry workflow folders", () => {
  it("mints fresh target folders and remaps every workflow onto them", async () => {
    await applySnapshot(db, await captureSnapshot(db, "sa_src"), "sa_tgt", scope);

    const { folders, workflows } = target();
    const created = folders.filter((f) => f.id !== "fA");
    expect(created.map((f) => [f.name, f.order])).toEqual([["Sales", 0], ["Ops", 1]]);
    for (const f of created) {
      expect(["fA", "fB"]).not.toContain(f.id);
      expect(f).toMatchObject({ agencyId: "ag1", subAccountId: "sa_tgt", createdByUid: "owner" });
    }
    expect(workflows).toEqual(EXPECTED);
    // The target's pre-existing folder is untouched and holds nothing new.
    expect(mem.read("subAccounts/sa_tgt/workflowFolders/fA")?.name).toBe("Target's own");
    // Source untouched.
    expect(mem.read("workflows/w1")?.folderId).toBe("fA");
    expect(mem.list("subAccounts/sa_src/workflowFolders")).toHaveLength(2);
  });

  it("survives the portable path (share link / exported file) with re-minted ids", async () => {
    const portable = toPortablePayload(await captureSnapshot(db, "sa_src"), new Set(["sa_src", "ag1"]));
    const parsed = parseSnapshotFile(
      JSON.parse(JSON.stringify(buildSnapshotFile("S", portable, new Date(0)))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const ids = (parsed.payload.workflowFolders ?? []).map((f) => f.sourceId);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("fA");
    expect(ids).not.toContain("fB");

    await applySnapshot(db, parsed.payload, "sa_tgt", scope);
    expect(target().workflows).toEqual(EXPECTED);
  });

  it("a payload without folders (template push, older snapshot) lands workflows Unfiled", async () => {
    const payload = await captureSnapshot(db, "sa_src");
    const older: SnapshotPayload = { ...payload, workflowFolders: undefined };

    await applySnapshot(db, older, "sa_tgt", scope);
    expect(target().workflows.map((w) => w.folder)).toEqual([null, null, null, null]);
  });
});

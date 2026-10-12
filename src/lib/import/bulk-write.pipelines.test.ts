import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A deal record's `pipeline_id` lands the deal on that pipeline only when it
 * names a pipeline of THIS sub-account and `stage` is on it — anything else
 * fails the record rather than strand the deal on a board that never
 * renders it. Real writeImportChunk over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { writeImportChunk } = await import("./bulk-write");

const deal = (extra: Record<string, unknown>) => ({
  external_id: "ext1", title: "Imported", value: 1, currency: "USD", contact_id: "c1", stage: "new", ...extra,
});
const importDeals = (records: unknown[]) =>
  writeImportChunk({
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u_importer",
    source: "ghl", entity: "deals", records,
  });
const stages = [
  { id: "follow_up", label: "Follow up", tone: "" },
  { id: "won", label: "Won", tone: "", terminal: "won" },
  { id: "lost", label: "Lost", tone: "", terminal: "lost" },
];

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa1/pipelines/P1", { name: "Sales", stages, subAccountId: "sa1" });
  mem.seed("subAccounts/sa2/pipelines/P2", { name: "Theirs", stages, subAccountId: "sa2" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
});

it("lands a deal on the named pipeline's stage, with an entry row on that pipeline", async () => {
  const r = await importDeals([deal({ pipeline_id: "P1", stage: "follow_up" })]);
  expect(r).toMatchObject({ created: 1, failed: 0 });
  expect(mem.list("deals")[0]).toMatchObject({ pipelineId: "P1", stageId: "follow_up" });
  expect(mem.list("dealStageHistory")).toEqual([
    expect.objectContaining({ pipelineId: "P1", stageId: "follow_up", fromStageId: null }),
  ]);
});

it("no pipeline_id ⇒ the default pipeline, written explicitly", async () => {
  await importDeals([deal({})]);
  expect(mem.list("deals")[0]).toMatchObject({ pipelineId: "default", stageId: "new" });
});

it("fails the record when pipeline_id is unknown, another sub-account's, or stage is not on it", async () => {
  const r = await importDeals([
    deal({ external_id: "a", pipeline_id: "P_missing", stage: "follow_up" }),
    deal({ external_id: "b", pipeline_id: "P2", stage: "follow_up" }),
    deal({ external_id: "c", pipeline_id: "P1", stage: "proposal" }),
  ]);
  expect(r.created).toBe(0);
  expect(r.errors.map((e) => [e.externalId, e.error])).toEqual([
    ["a", "deal: pipeline_id is not a pipeline in this sub-account"],
    ["b", "deal: pipeline_id is not a pipeline in this sub-account"],
    ["c", 'deal: stage "proposal" is not on pipeline "P1"'],
  ]);
  expect(mem.list("deals")).toEqual([]);
});

it("a re-import that changes only the pipeline moves the deal and writes a move row", async () => {
  await importDeals([deal({ stage: "won" })]);
  const id = mem.list("deals")[0].id;
  await importDeals([deal({ pipeline_id: "P1", stage: "won" })]);
  expect(mem.read(`deals/${id}`)).toMatchObject({ pipelineId: "P1", stageId: "won" });
  expect(mem.list("dealStageHistory").filter((r) => r.fromStageId !== null)).toEqual([
    expect.objectContaining({ fromPipelineId: "default", pipelineId: "P1", fromStageId: "won", stageId: "won" }),
  ]);

  // And back: a re-import without pipeline_id returns it to the default.
  await importDeals([deal({ stage: "new" })]);
  expect(mem.read(`deals/${id}`)).toMatchObject({ pipelineId: "default", stageId: "new" });
});

it("a pre-pipeline deal (no pipelineId field) re-imported onto the default writes no move row", async () => {
  await importDeals([deal({})]);
  const id = mem.list("deals")[0].id;
  const { pipelineId: _drop, ...legacy } = mem.read(`deals/${id}`)!;
  mem.seed(`deals/${id}`, legacy);
  await importDeals([deal({})]);
  expect(mem.list("dealStageHistory")).toHaveLength(1);
});

import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Bulk import writes a deal's stage-history row in the same batch as the
 * deal: an entry row on create, a move row when a re-import lands the deal
 * on a different stage, nothing when the stage is unchanged. Real
 * writeImportChunk over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { writeImportChunk } = await import("./bulk-write");

const deal = (stage: string) => ({
  external_id: "ext1", title: "Imported", value: 1, currency: "USD", contact_id: "c1", stage,
});
const importDeals = (records: unknown[]) =>
  writeImportChunk({
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u_importer",
    source: "ghl", entity: "deals", records,
  });
const rows = () => mem.list("dealStageHistory");

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
});

it("create ⇒ entry row; same-stage re-import ⇒ none; changed stage ⇒ move row + stageChangedAt", async () => {
  expect((await importDeals([deal("new")])).created).toBe(1);
  const id = mem.list("deals")[0].id;
  expect(rows()).toEqual([
    expect.objectContaining({
      dealId: id, fromStageId: null, stageId: "new", source: "import",
      createdByUid: "u_importer", subAccountId: "sa1", agencyId: "ag1", mode: "live",
    }),
  ]);

  mem.seed(`deals/${id}`, { ...mem.read(`deals/${id}`), stageChangedAt: new Date("2026-01-01") });
  expect((await importDeals([deal("new")])).updated).toBe(1);
  expect(rows()).toHaveLength(1);
  expect(mem.read(`deals/${id}`)?.stageChangedAt).toEqual(new Date("2026-01-01"));

  await importDeals([deal("proposal")]);
  expect(rows().filter((r) => r.fromStageId !== null)).toEqual([
    expect.objectContaining({
      dealId: id, fromStageId: "new", stageId: "proposal",
      fromStageEnteredAt: new Date("2026-01-01"), source: "import",
    }),
  ]);
  expect(mem.read(`deals/${id}`)?.stageChangedAt).not.toEqual(new Date("2026-01-01"));
});

it("the same deal twice in one chunk compares against the first record, not the stored doc", async () => {
  await importDeals([deal("new"), deal("new"), deal("won")]);
  expect(rows().map((r) => [r.fromStageId, r.stageId])).toEqual([
    [null, "new"],
    ["new", "won"],
  ]);
});

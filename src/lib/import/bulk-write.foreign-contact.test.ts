import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * An import record may name its parent contact by `contact_id` directly.
 * That id must belong to the importing sub-account: a foreign id fails the
 * record and writes nothing — above all no note under the other tenant's
 * contact. Real writeImportChunk over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { writeImportChunk } = await import("./bulk-write");

const importChunk = (entity: "notes" | "deals" | "tasks" | "events", records: unknown[]) =>
  writeImportChunk({
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u_importer",
    source: "ghl", entity, records,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("contacts/cB", { subAccountId: "saB", agencyId: "ag1", name: "Foreign" });
});

it("a note naming a foreign contact_id fails and is not written under that contact", async () => {
  const r = await importChunk("notes", [
    { external_id: "n1", contact_id: "cB", content: "hello" },
    { external_id: "n2", contact_id: "c1", content: "mine" },
  ]);
  expect(r).toMatchObject({ created: 1, failed: 1 });
  expect(r.errors).toEqual([expect.objectContaining({ externalId: "n1" })]);
  expect(mem.list("contacts/cB/notes")).toEqual([]);
  expect(mem.list("contacts/c1/notes")).toEqual([expect.objectContaining({ content: "mine" })]);
});

it.each([
  ["deals", { title: "D", value: 1, currency: "USD", stage: "new" }],
  ["tasks", { title: "T" }],
  ["events", { title: "E", start_at: "2026-10-01T09:00:00Z", end_at: "2026-10-01T10:00:00Z" }],
] as const)("%s naming a foreign contact_id fail and write nothing", async (entity, rec) => {
  const r = await importChunk(entity, [{ external_id: "x1", contact_id: "cB", ...rec }]);
  expect(r).toMatchObject({ created: 0, failed: 1 });
  expect(mem.list(entity)).toEqual([]);
});

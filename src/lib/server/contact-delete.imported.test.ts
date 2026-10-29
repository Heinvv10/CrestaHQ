import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * An event imported from a member's Google Calendar only references a
 * contact for display, and is read-only in the CRM — so it must not make the
 * contact undeletable. It never blocks the delete; the delete unlinks it.
 * A real booking for the contact still blocks.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/server/contacts-service", () => ({ emitContactDeleted: () => undefined }));

const { deleteContactServerSide, findContactBlockers } = await import("./contact-delete");

const own = { subAccountId: "sa1", agencyId: "ag1" };
beforeEach(() => {
  mem.clear();
  mem.seed("contacts/c1", { ...own, name: "Ann" });
  mem.seed("events/g1", { ...own, contactId: "c1", source: "google", title: "Lunch with Ann" });
});

describe("deleting a contact linked to an imported Google event", () => {
  it("is not blocked, and leaves the event unlinked", async () => {
    expect((await findContactBlockers(mem.db as never, "sa1", "c1")).blockers).toEqual([]);
    expect(await deleteContactServerSide({ contactId: "c1", subAccountId: "sa1" })).toEqual({ status: "deleted" });
    expect(mem.read("contacts/c1")).toBeUndefined();
    expect(mem.read("events/g1")).toMatchObject({ contactId: null, title: "Lunch with Ann" });
  });

  it("a booking alongside it still blocks, counted without the imported one", async () => {
    mem.seed("events/b1", { ...own, contactId: "c1", source: "booking_page" });
    expect(await deleteContactServerSide({ contactId: "c1", subAccountId: "sa1" })).toEqual({
      status: "blocked",
      blockers: [{ type: "events", label: "calendar event / booking", count: 1 }],
    });
    expect(mem.read("events/g1")?.contactId).toBe("c1");
  });
});

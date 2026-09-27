import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The services behind the v1 routes never build a contact path from an id
 * that isn't a doc id: the lookup reads nothing (territory falls back to
 * Global, the summary is null, the link check is false) and no activity is
 * written under it. "c1/sub/s1" names a subcollection doc seeded with the
 * tenant's fields; "__x__" a reserved id seeded the same way, which the old
 * "no slash" checks let through.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { refInSubAccount } = await import("./tenant-ref");
const { territoryForContact, createTaskServerSide, setTaskCompletedServerSide } = await import("./tasks-service");
const { createEventServerSide } = await import("./events-service");
const { createDealServerSide, fetchDealContactSummary } = await import("./deals-service");

const own = { subAccountId: "sa1", agencyId: "ag1", mode: "live", territoryId: "north", name: "Hidden" };
const BAD = ["c1/sub/s1", "__x__"];
const activitiesUnder = (id: string) => mem.list(`contacts/${id}/activities`);
const base = { subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", mode: "live" as const };

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ownerUid: "u1" });
  for (const id of BAD) mem.seed(`contacts/${id}`, own);
});

describe.each(BAD)("contact id %j", (bad) => {
  it("refInSubAccount is false", async () => {
    expect(await refInSubAccount("contacts", bad, "sa1", "live")).toBe(false);
  });

  it("territoryForContact falls back to Global", async () => {
    expect(await territoryForContact(bad)).toBe("global");
  });

  it("fetchDealContactSummary is null", async () => {
    expect(await fetchDealContactSummary(bad)).toBeNull();
  });

  it("createTaskServerSide writes no activity under it and takes no territory from it", async () => {
    const { id } = await createTaskServerSide({ ...base, title: "T", notes: "", dueAt: null, contactId: bad, dealId: null, eventId: null });
    expect(activitiesUnder(bad)).toEqual([]);
    expect(mem.read(`tasks/${id}`)).toMatchObject({ territoryId: "global" });
  });

  it("completing a legacy task linked to it writes no activity", async () => {
    mem.seed("tasks/t1", { ...base, title: "T", completed: false, contactId: bad });
    await setTaskCompletedServerSide({ taskId: "t1", completed: true, userId: "u1" });
    expect(activitiesUnder(bad)).toEqual([]);
  });

  it("createEventServerSide writes no activity under it and takes no territory from it", async () => {
    const startAt = new Date(Date.now() + 86_400_000);
    const { id } = await createEventServerSide({
      ...base, title: "E", startAt, endAt: new Date(startAt.getTime() + 3_600_000), contactId: bad, location: "", notes: "",
    });
    expect(activitiesUnder(bad)).toEqual([]);
    expect(mem.read(`events/${id}`)).toMatchObject({ territoryId: "global" });
  });

  it("createDealServerSide writes no pipeline activity under it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createDealServerSide({
      ...base, title: "D", value: 1, currency: "USD", contactId: bad, stageId: "new", priority: "medium", source: "app",
    });
    warn.mockRestore();
    expect(activitiesUnder(bad)).toEqual([]);
  });
});

it("a real contact id still links (the guards don't over-refuse)", async () => {
  mem.seed("contacts/c1", own);
  expect(await refInSubAccount("contacts", "c1", "sa1", "live")).toBe(true);
  expect(await territoryForContact("c1")).toBe("north");
  await createTaskServerSide({ ...base, title: "T", notes: "", dueAt: null, contactId: "c1", dealId: null, eventId: null });
  expect(activitiesUnder("c1")).toHaveLength(1);
});

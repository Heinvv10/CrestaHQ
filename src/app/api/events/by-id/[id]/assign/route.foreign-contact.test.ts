import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A legacy event can still hold a contactId from ANOTHER sub-account (written
 * before links were tenant-checked). Reassigning it must not write a timeline
 * row onto that foreign contact.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => {} }));

const { POST } = await import("./route");

const ts = (iso: string) => {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
};
const reassign = (id: string) =>
  POST(
    new Request("http://x/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedToUid: "b" }),
    }),
    { params: Promise.resolve({ id }) },
  );
const seedEvent = (contactId: string) =>
  mem.seed("events/ev", {
    subAccountId: "sa1",
    agencyId: "ag1",
    source: "booking_page",
    bookingPageSlug: "p",
    status: "scheduled",
    contactId,
    assignedToUid: "a",
    startAt: ts("2026-09-14T09:00:00Z"),
    endAt: ts("2026-09-14T09:30:00Z"),
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1/bookingPages/p", { hosts: [{ uid: "a", name: "A" }, { uid: "b", name: "B" }] });
  for (const uid of ["a", "b"]) mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { uid, status: "active", displayName: uid });
  mem.seed("contacts/mine", { subAccountId: "sa1", agencyId: "ag1" });
  mem.seed("contacts/theirs", { subAccountId: "sa2", agencyId: "ag1" });
});

describe("reassign — timeline row", () => {
  it("logs booking_reassigned on this sub-account's contact", async () => {
    seedEvent("mine");
    expect((await reassign("ev")).status).toBe(200);
    expect(mem.list("contacts/mine/activities")).toEqual([expect.objectContaining({ type: "booking_reassigned" })]);
  });

  it("writes nothing onto a contact in another sub-account, and still reassigns", async () => {
    seedEvent("theirs");
    expect((await reassign("ev")).status).toBe(200);
    expect(mem.read("events/ev")).toMatchObject({ assignedToUid: "b" });
    expect(mem.list("contacts/theirs/activities")).toEqual([]);
  });
});

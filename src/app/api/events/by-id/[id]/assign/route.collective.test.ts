import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Reassigning a collective booking is refused: every host in hostUids is
 * attending and busy for it, so moving only the owner would leave the list
 * wrong. A one-host booking still reassigns.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({
    uid: "u1",
    agencyId: "ag1",
    subAccountId: "sa1",
    subAccountRole: "admin",
  }),
}));

const { POST } = await import("./route");

const ts = (iso: string) => {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
};
const reassign = (id: string, assignedToUid: string) =>
  POST(
    new Request("http://x/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedToUid }),
    }),
    { params: Promise.resolve({ id }) },
  );
const seedEvent = (id: string, extra: object) =>
  mem.seed(`events/${id}`, {
    id,
    subAccountId: "sa1",
    agencyId: "ag1",
    source: "booking_page",
    bookingPageSlug: "p",
    status: "scheduled",
    contactId: null,
    startAt: ts("2026-09-14T09:00:00Z"),
    endAt: ts("2026-09-14T09:30:00Z"),
    ...extra,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1/bookingPages/p", {
    hosts: [{ uid: "a", name: "A" }, { uid: "b", name: "B" }, { uid: "c", name: "C" }],
  });
  for (const uid of ["a", "b", "c"]) {
    mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { uid, status: "active", displayName: uid });
  }
});

describe("reassign", () => {
  it("refuses a collective booking and leaves it untouched", async () => {
    seedEvent("col", { assignedToUid: "a", assignedToName: "A", hostUids: ["a", "b"] });
    const res = await reassign("col", "c");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/collective/i);
    expect(mem.read("events/col")).toMatchObject({ assignedToUid: "a", hostUids: ["a", "b"] });
  });

  it("warns when the target is a host on an overlapping collective booking", async () => {
    // c is not its owner, but attends it.
    seedEvent("col", { assignedToUid: "b", hostUids: ["b", "c"] });
    seedEvent("rr", { assignedToUid: "a", assignedToName: "A" });
    const res = await reassign("rr", "c");
    expect(await res.json()).toMatchObject({ ok: false, needsConfirm: true });
    expect(mem.read("events/rr")).toMatchObject({ assignedToUid: "a" });
  });

  it("still moves a one-host booking", async () => {
    seedEvent("rr", { assignedToUid: "a", assignedToName: "A" });
    const res = await reassign("rr", "c");
    expect(res.status).toBe(200);
    expect(mem.read("events/rr")).toMatchObject({ assignedToUid: "c", assignedToName: "c" });
  });
});

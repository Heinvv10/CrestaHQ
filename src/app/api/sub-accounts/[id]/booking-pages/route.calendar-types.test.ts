import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";

/**
 * Create / update a typed booking page through the real routes, validator
 * and host resolution. The host-count rule runs again after hosts are
 * resolved against live membership, since that can drop a host.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1", agencyId: "ag1" }),
  requireSubAccountMember: async () => ({ uid: "u1", agencyId: "ag1" }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[slug]/route");

const body = (extra: object) => ({
  ...defaultBookingPageFormData("team", "UTC"),
  name: "Team",
  ...extra,
});
const req = (method: string, b: unknown) =>
  new Request("http://x/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
const member = (uid: string, status = "active") =>
  mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, {
    uid,
    status,
    displayName: uid.toUpperCase(),
    subAccountId: "sa1",
    agencyId: "ag1",
  });
const create = (extra: object) =>
  POST(req("POST", body(extra)), { params: Promise.resolve({ id: "sa1" }) });
const stored = () => mem.read("subAccounts/sa1/bookingPages/team");

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  member("a");
  member("b");
  member("gone", "removed");
});

describe("booking-page routes with a calendar type", () => {
  it("stores a round-robin page with its distribution and host priorities", async () => {
    const res = await create({
      calendarType: "round_robin",
      distribution: "availability",
      hosts: [{ uid: "a", name: "x", priority: 3 }, { uid: "b", name: "y" }],
    });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({
      calendarType: "round_robin",
      distribution: "availability",
      hosts: [{ uid: "a", name: "A", priority: 3 }, { uid: "b", name: "B" }],
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "u1",
    });
  });

  it("keeps each host's date-specific hours and the page's new rules through host resolution", async () => {
    const closed = [{ date: "2026-12-24", ranges: [] }];
    const res = await create({
      bufferBeforeMinutes: 10,
      slotIntervalMinutes: 15,
      dateOverrides: [{ date: "2026-12-25", ranges: [] }],
      hosts: [{ uid: "a", name: "a", dateOverrides: closed }],
    });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({
      bufferBeforeMinutes: 10,
      slotIntervalMinutes: 15,
      dateOverrides: [{ date: "2026-12-25", ranges: [] }],
      hosts: [{ uid: "a", name: "A", dateOverrides: closed }],
    });
  });

  it("refuses a collective page left with one active host", async () => {
    const res = await create({
      calendarType: "collective",
      hosts: [{ uid: "a", name: "a" }, { uid: "gone", name: "g" }],
    });
    expect(res.status).toBe(400);
    expect(stored()).toBeUndefined();
  });

  it("switching type on PATCH clears the old type's fields", async () => {
    await create({ calendarType: "class", seatsPerSlot: 5 });
    const res = await PATCH(req("PATCH", body({ calendarType: "personal", hosts: [{ uid: "a", name: "a" }] })), {
      params: Promise.resolve({ id: "sa1", slug: "team" }),
    });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ calendarType: "personal", seatsPerSlot: null, services: null });
  });

  it("a PATCH without a type checks hosts against the stored type", async () => {
    await create({ calendarType: "collective", hosts: [{ uid: "a", name: "a" }, { uid: "b", name: "b" }] });
    const res = await PATCH(req("PATCH", body({ hosts: [{ uid: "a", name: "a" }] })), {
      params: Promise.resolve({ id: "sa1", slug: "team" }),
    });
    expect(res.status).toBe(400);
  });
});

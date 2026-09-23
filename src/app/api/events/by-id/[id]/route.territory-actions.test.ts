import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Every operator action under /api/events/by-id/[id]/* applies the events
 * read rule's territory clause, like the DELETE beside it: a scoped
 * collaborator is refused an out-of-territory event before any side effect.
 * Real territory-filter; in-memory Firestore; downstream services are spies.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({
  role: "collaborator" as string,
  sideEffects: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_r: Request, subAccountId: string) => ({
    uid: "u1",
    subAccountId,
    subAccountRole: t.role,
  }),
}));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogle: async () => void t.sideEffects.push("google"),
}));
vi.mock("@/lib/booking/hosts", () => ({ queryHostEvents: async () => [] }));
vi.mock("@/lib/server/bookings-service", () => ({
  markBookingPaidServerSide: async () => (t.sideEffects.push("paid"), { ok: true }),
}));
vi.mock("@/lib/server/event-status-service", () => ({
  changeEventStatus: async () => (t.sideEffects.push("status"), { ok: true }),
}));
vi.mock("@/lib/booking/event-token", () => ({ buildEventPublicUrl: () => "http://x/e" }));
vi.mock("@/lib/booking/reschedule", () => ({
  RescheduleRejected: class extends Error {},
  rescheduleWithoutAvailabilityCheck: async () => {
    t.sideEffects.push("reschedule");
    return { event: {}, newToken: "tok", page: {} };
  },
  runRescheduleSideEffects: async () => ({ emailSent: false }),
}));

const routes = {
  assign: { mod: await import("./assign/route"), body: { assignedToUid: "u2" } },
  "google-sync": { mod: await import("./google-sync/route"), body: {} },
  "mark-paid": { mod: await import("./mark-paid/route"), body: {} },
  "mark-status": { mod: await import("./mark-status/route"), body: { status: "completed" } },
  reschedule: {
    mod: await import("./reschedule/route"),
    body: { startAt: "2026-10-01T09:00:00Z", endAt: "2026-10-01T10:00:00Z" },
  },
};

const call = (name: keyof typeof routes, id: string) =>
  routes[name].mod.POST(
    new Request(`http://x/api/events/by-id/${id}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routes[name].body),
    }),
    { params: Promise.resolve({ id }) },
  );

const DENIAL = "This record isn't in one of your assigned territories.";

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.sideEffects = [];
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  const base = { agencyId: "ag1", subAccountId: "sa1", source: "booking_page", status: "scheduled" };
  mem.seed("events/in", { ...base, id: "in", territoryId: "t1" });
  mem.seed("events/out", { ...base, id: "out", territoryId: "t2" });
});

describe.each(Object.keys(routes) as Array<keyof typeof routes>)(
  "POST /api/events/by-id/[id]/%s",
  (name) => {
    it("refuses a scoped collaborator an out-of-territory event, with no side effect", async () => {
      const before = mem.read("events/out");
      const res = await call(name, "out");
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(DENIAL);
      expect(t.sideEffects).toEqual([]);
      expect(mem.read("events/out")).toEqual(before);
    });

    it("passes the territory gate for an in-territory event", async () => {
      const res = await call(name, "in");
      expect((await res.json().catch(() => ({}))).error).not.toBe(DENIAL);
    });

    it("does not scope an admin", async () => {
      t.role = "admin";
      const res = await call(name, "out");
      expect((await res.json().catch(() => ({}))).error).not.toBe(DENIAL);
    });
  },
);

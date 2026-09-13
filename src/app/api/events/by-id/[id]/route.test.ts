import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * DELETE /api/events/by-id/[id] — the server delete for an event mirrored in
 * a host's Google Calendar (the rules refuse the client delete): Google copies
 * come down first, then the event; authorised against the event's own
 * sub-account and the caller's territory scope.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const t = vi.hoisted(() => ({
  member: vi.fn(async (_r: Request, subAccountId: string) => ({ uid: "u1", subAccountId, subAccountRole: "collaborator" })),
  gate: vi.fn(async () => null as Response | null),
  removed: [] as Array<{ id: string; existed: boolean }>,
}));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountMember: t.member }));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGate: t.gate }));
vi.mock("@/lib/google-calendar/push", () => ({
  removeBookingFromGoogle: async (id: string) => {
    t.removed.push({ id, existed: !!mem.read(`events/${id}`) });
  },
}));

const { DELETE } = await import("./route");
const del = (id: string) => DELETE(new Request("http://x/api", { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  mem.clear();
  t.removed = [];
  t.member.mockClear();
  t.gate.mockReset().mockResolvedValue(null);
  mem.seed("events/e1", { id: "e1", subAccountId: "sa_x", agencyId: "ag1", territoryId: "t1", status: "completed", googleEventIds: { a: "g" } });
});

describe("DELETE /api/events/by-id/[id]", () => {
  it("removes the Google copies while the event still exists, then deletes it", async () => {
    expect((await del("e1")).status).toBe(200);
    expect(t.removed).toEqual([{ id: "e1", existed: true }]);
    expect(mem.read("events/e1")).toBeUndefined();
    expect(t.member).toHaveBeenCalledWith(expect.any(Request), "sa_x");
    expect(t.gate).toHaveBeenCalledWith(expect.objectContaining({ subAccountId: "sa_x" }), "t1");
  });

  it("a territory refusal deletes nothing and touches no Google calendar", async () => {
    t.gate.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await del("e1")).status).toBe(403);
    expect(t.removed).toEqual([]);
    expect(mem.read("events/e1")).toBeDefined();
  });

  it("404 for an unknown event", async () => {
    expect((await del("nope")).status).toBe(404);
  });
});

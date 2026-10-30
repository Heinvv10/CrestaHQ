import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * An event imported from a member's Google Calendar is read-only in the CRM.
 * The dashboard's server routes refuse it before touching anything: delete,
 * Google retry-sync, and a status change (through the real status service,
 * the chokepoint the v1 API and the assistant share).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const t = vi.hoisted(() => ({
  removed: [] as string[],
  pushed: [] as string[],
  trigger: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_r: Request, subAccountId: string) => ({ uid: "u1", subAccountId, subAccountRole: "admin" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGate: async () => null }));
vi.mock("@/lib/google-calendar/push", () => ({
  removeBookingFromGoogleBeforeDelete: async (id: string) => {
    t.removed.push(id);
    return { ok: true };
  },
  pushBookingToGoogle: async (id: string) => void t.pushed.push(id),
}));
vi.mock("@/lib/booking/lifecycle", () => ({ fireBookingTrigger: t.trigger, recordBookingActivity: t.activity }));
vi.mock("@/lib/comms/resend", () => ({ emailIsConfigured: () => false, sendEmail: vi.fn(), tenantFrom: () => "x@example.com" }));

const { DELETE } = await import("./route");
const { POST: retrySync } = await import("./google-sync/route");
const { POST: markStatus } = await import("./mark-status/route");

const params = { params: Promise.resolve({ id: "g1" }) };
const json = (body: unknown) =>
  new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const PAST = new Date(Date.now() - 2 * 60 * 60_000);
const seed = (over: Record<string, unknown> = {}) =>
  mem.seed("events/g1", {
    subAccountId: "sa1",
    agencyId: "ag1",
    territoryId: "global",
    status: "scheduled",
    source: "google",
    title: "Dentist",
    contactId: "c1",
    startAt: PAST,
    endAt: new Date(PAST.getTime() + 30 * 60_000),
    ...over,
  });

beforeEach(() => {
  mem.clear();
  t.removed = [];
  t.pushed = [];
  t.trigger.mockReset();
  t.activity.mockReset();
  seed();
});

describe("an imported Google event", () => {
  it("can't be deleted through the dashboard route", async () => {
    const res = await DELETE(new Request("http://x/api", { method: "DELETE" }), params);
    expect(res.status).toBe(400);
    expect(mem.read("events/g1")).toBeDefined();
    expect(t.removed).toEqual([]);
  });

  it("can't be retry-synced to Google, and isn't stamped", async () => {
    const res = await retrySync(new Request("http://x/api", { method: "POST" }), params);
    expect(res.status).toBe(400);
    expect(t.pushed).toEqual([]);
    expect(mem.read("events/g1")?.googleSyncRetryAt).toBeUndefined();
  });

  it.each(["completed", "no_show", "cancelled"])("can't be marked %s: nothing written, no trigger", async (status) => {
    const res = await markStatus(json({ status }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This event comes from Google Calendar — change it there." });
    expect(mem.read("events/g1")?.status).toBe("scheduled");
    expect(t.trigger).not.toHaveBeenCalled();
    expect(t.activity).not.toHaveBeenCalled();
    expect(t.pushed).toEqual([]);
  });

  it("a manual event is still marked (control)", async () => {
    seed({ source: "manual" });
    expect((await markStatus(json({ status: "completed" }), params)).status).toBe(200);
    expect(mem.read("events/g1")?.status).toBe("completed");
  });
});

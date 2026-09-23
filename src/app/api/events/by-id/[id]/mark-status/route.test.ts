import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventStatus } from "@/types/events";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  fireBookingTrigger: vi.fn(),
  recordBookingActivity: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
// Territory scoping is covered in ../route.territory-actions.test.ts.
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGate: async () => null }));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: m.fireBookingTrigger,
  recordBookingActivity: m.recordBookingActivity,
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => false,
  sendEmail: vi.fn(),
  tenantFrom: () => "test@example.com",
}));
vi.mock("@/lib/booking/email", () => ({
  renderBookingCancelledEmail: () => ({ subject: "", text: "", html: "" }),
}));

let eventDoc: Record<string, unknown>;
let updatedPatch: Record<string, unknown> | null;
/** Doc paths `update()` was called on — proves the write hit the real event. */
let updatedPaths: string[];

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      // Honours its argument: only `events/evt1` exists, and a doc built
      // from an undefined id is a different (missing) doc, exactly as in
      // Firestore — so a caller that loses the id is caught here.
      doc: (id: string) => ({
        get: async () => ({
          exists: name === "events" && id === "evt1",
          data: () => eventDoc,
        }),
        update: async (patch: Record<string, unknown>) => {
          if (typeof id !== "string" || id.length === 0) {
            throw new Error(`update on an invalid doc id: ${String(id)}`);
          }
          updatedPaths.push(`${name}/${id}`);
          updatedPatch = patch;
        },
      }),
    }),
    doc: () => ({ get: async () => ({ exists: false }) }),
  }),
}));

const { POST } = await import("./route");

function post(status: EventStatus) {
  return POST(
    new Request("https://example.com/api/events/by-id/evt1/mark-status", {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: "evt1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  updatedPatch = null;
  updatedPaths = [];
  m.access.mockResolvedValue({ uid: "u1", agencyId: "ag1" });
  // Realistic manual-or-booking fixture: NO stored `id` field — the
  // events-service and v1 POST creates never write one.
  eventDoc = {
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    bookingPageSlug: "page-a",
    title: "Meeting",
    // Past by default — completed/no_show transitions are refused for a
    // future-dated event (see event-status-service.test.ts for that gate).
    startAt: { toDate: () => new Date(Date.now() - 60 * 60_000) },
  };
});

describe("POST mark-status — trigger firing", () => {
  it("fires event_completed on scheduled -> completed", async () => {
    eventDoc.status = "scheduled";
    const res = await post("completed");
    expect(res.status).toBe(200);
    expect(updatedPatch?.status).toBe("completed");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "evt1",
        contactId: "c1",
        bookingPageSlug: "page-a",
      }),
      "event_completed",
    );
  });

  it("fires event_no_show on scheduled -> no_show", async () => {
    eventDoc.status = "scheduled";
    await post("no_show");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "event_no_show",
    );
  });

  it("fires event_no_show again on a completed -> no_show correction", async () => {
    eventDoc.status = "completed";
    const res = await post("no_show");
    expect(res.status).toBe(200);
    expect(updatedPatch?.status).toBe("no_show");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "event_no_show",
    );
  });

  it("fires event_completed again on a no_show -> completed correction", async () => {
    eventDoc.status = "no_show";
    const res = await post("completed");
    expect(res.status).toBe(200);
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "event_completed",
    );
  });

  it("rejects cancelled -> completed with 409 and fires nothing", async () => {
    eventDoc.status = "cancelled";
    const res = await post("completed");
    expect(res.status).toBe(409);
    expect(updatedPatch).toBeNull();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("rejects completed on a future-dated scheduled event with 409, writes nothing", async () => {
    eventDoc.status = "scheduled";
    eventDoc.startAt = { toDate: () => new Date(Date.now() + 60 * 60_000) };
    const res = await post("completed");
    expect(res.status).toBe(409);
    expect(updatedPatch).toBeNull();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("fires event_cancelled on scheduled -> cancelled", async () => {
    eventDoc.status = "scheduled";
    await post("cancelled");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "event_cancelled",
    );
  });

  it("writes to the event at its path id even though the doc stores no `id` field", async () => {
    eventDoc.status = "scheduled";
    const res = await post("completed");
    expect(res.status).toBe(200);
    expect(updatedPaths).toEqual(["events/evt1"]);
  });
});

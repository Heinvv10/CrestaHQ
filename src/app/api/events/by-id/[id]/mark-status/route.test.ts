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

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => eventDoc }),
        update: async (patch: Record<string, unknown>) => {
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
  m.access.mockResolvedValue({ uid: "u1", agencyId: "ag1" });
  eventDoc = {
    id: "evt1",
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    bookingPageSlug: "page-a",
    title: "Meeting",
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

  it("fires event_cancelled on scheduled -> cancelled", async () => {
    eventDoc.status = "scheduled";
    await post("cancelled");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "event_cancelled",
    );
  });
});

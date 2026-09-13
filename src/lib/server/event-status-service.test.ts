import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEvent, EventStatus } from "@/types/events";

const m = vi.hoisted(() => ({
  fireBookingTrigger: vi.fn(),
  recordBookingActivity: vi.fn(),
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

const STATUSES: EventStatus[] = [
  "scheduled",
  "awaiting_payment",
  "completed",
  "cancelled",
  "no_show",
];

let updatedPatch: Record<string, unknown> | null;

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false }),
        update: async (patch: Record<string, unknown>) => {
          updatedPatch = patch;
        },
      }),
    }),
    doc: () => ({ get: async () => ({ exists: false }) }),
  }),
}));

const { changeEventStatus, isValidStatusTransition } = await import(
  "./event-status-service"
);

function event(status: EventStatus): CalendarEvent {
  return {
    id: "evt1",
    title: "Meeting",
    startAt: null,
    endAt: null,
    contactId: "c1",
    location: "",
    notes: "",
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    status,
    bookingPageSlug: "page-a",
    createdAt: null,
    updatedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updatedPatch = null;
});

describe("isValidStatusTransition — every from→to pair", () => {
  const expected: Record<string, boolean> = {
    "scheduled->scheduled": true,
    "scheduled->awaiting_payment": false,
    "scheduled->completed": true,
    "scheduled->cancelled": true,
    "scheduled->no_show": true,
    "awaiting_payment->scheduled": false,
    "awaiting_payment->awaiting_payment": true,
    "awaiting_payment->completed": false,
    "awaiting_payment->cancelled": true,
    "awaiting_payment->no_show": false,
    "completed->scheduled": false,
    "completed->awaiting_payment": false,
    "completed->completed": true,
    "completed->cancelled": false,
    "completed->no_show": true,
    "cancelled->scheduled": false,
    "cancelled->awaiting_payment": false,
    "cancelled->completed": false,
    "cancelled->cancelled": true,
    "cancelled->no_show": false,
    "no_show->scheduled": false,
    "no_show->awaiting_payment": false,
    "no_show->completed": true,
    "no_show->cancelled": false,
    "no_show->no_show": true,
  };

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      it(`${from} -> ${to} is ${expected[`${from}->${to}`]}`, () => {
        expect(isValidStatusTransition(from, to)).toBe(
          expected[`${from}->${to}`],
        );
      });
    }
  }
});

describe("changeEventStatus", () => {
  it("no-ops when current === next, without touching Firestore or firing anything", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "scheduled");
    expect(outcome).toEqual({ ok: true, httpStatus: 200, status: "scheduled", noop: true });
    expect(updatedPatch).toBeNull();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("rejects an invalid transition with 409 and fires nothing", async () => {
    const outcome = await changeEventStatus(event("cancelled"), "scheduled");
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(409);
    expect(updatedPatch).toBeNull();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("awaiting_payment -> scheduled is rejected (mark-paid only)", async () => {
    const outcome = await changeEventStatus(event("awaiting_payment"), "scheduled");
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(409);
    expect(outcome.error).toMatch(/mark as paid/i);
  });

  it("applies a valid transition, writes the patch, and fires the matching trigger", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "completed");
    expect(outcome.ok).toBe(true);
    expect(outcome.httpStatus).toBe(200);
    expect(updatedPatch?.status).toBe("completed");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1", contactId: "c1", bookingPageSlug: "page-a" }),
      "event_completed",
    );
  });

  it("cancels: stamps cancelledAt/cancelReason and fires event_cancelled", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "cancelled", "no longer needed");
    expect(outcome.ok).toBe(true);
    expect(updatedPatch?.status).toBe("cancelled");
    expect(updatedPatch?.cancelReason).toBe("no longer needed");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(expect.anything(), "event_cancelled");
  });
});
